// Built-in task programs. The Borglet runs tasks by re-executing itself as
// `borglet --worker <type>`, so the image needs no extra tools. The task's settings arrive in
// environment variables set by the Borglet:
//
//   BORG_WORKLOAD   the job's workload as JSON, e.g. {"type":"cpu","threads":2,"duration":30}
//   BORG_TASK       "<job>/<index>"         BORG_MACHINE  the machine's name
//   BORG_PORT       the first TCP port Borg assigned to this task (§2.3), if it asked for one
//   BORG_BORGLET    the local Borglet, used to look up other tasks by name (§2.6)
//   BORG_NOTE       a file the task writes one line of status to; the Borglet reports it (task.note)
//
// Workload types (duration <= 0 means "forever"):
//   service   long-running server: ~20 MB resident, light periodic CPU. With a port it serves
//             GET /         a greeting          GET /health  the health check (§2.6)
//             GET /load?cpu=1.5&secs=20         burn CPU (a load spike, §5.5)
//             GET /mem?mb=100&secs=20           hold extra memory
//             GET /admin/sick | /admin/hang | /admin/ok   make the health check fail / recover
//             options: unhealthy_after, hang_after (seconds), crash_on (a machine name)
//             Inside an alloc it also appends each request to access.log in the alloc's shared
//             directory (BORG_ALLOC_DIR)
//   logsaver  the classic helper next to a web server in the same alloc (§2.4): "saves" the
//             lines the server appended to access.log
//   client    calls another job's tasks by name: {target, rps}
//   sleep     idle, then exit 0                 cpu   busy-loop {threads}
//   mem       allocate and hold {mb} MB         disk  write {mb} MB into the task's directory
//   crash     run, then exit 1; with {only_on: <machine>} it crashes only on that machine
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "httplib.h"
#include "json.hpp"

namespace {

using Clock = std::chrono::steady_clock;
using json = nlohmann::json;

std::string env_s(const char* key, const std::string& def = "") {
    const char* v = std::getenv(key);
    return v && *v ? v : def;
}

bool expired(Clock::time_point start, double secs) {
    return secs > 0 && std::chrono::duration<double>(Clock::now() - start).count() >= secs;
}

double since(Clock::time_point start) { return std::chrono::duration<double>(Clock::now() - start).count(); }

void nap(double secs) { std::this_thread::sleep_for(std::chrono::duration<double>(secs)); }

std::vector<char*> touch(size_t mb, std::vector<char*> blocks = {}) {
    for (size_t i = 0; i < mb; ++i) {
        char* p = static_cast<char*>(std::malloc(1 << 20));
        if (!p) break;
        std::memset(p, static_cast<int>(i & 0xff), 1 << 20);
        blocks.push_back(p);
    }
    return blocks;
}

void spin(std::atomic<bool>& stop) {
    volatile uint64_t x = 0;
    while (!stop.load(std::memory_order_relaxed)) x = x * 6364136223846793005ULL + 1;
}

// Uses about `cores` CPUs for `secs` seconds; a fractional core is a busy/idle duty cycle.
void burn(double cores, double secs) {
    int threads = std::max(1, static_cast<int>(std::ceil(cores)));
    double share = std::min(1.0, cores / threads);
    auto start = Clock::now();
    std::vector<std::thread> ts;
    for (int i = 0; i < threads; ++i) {
        ts.emplace_back([=] {
            while (!expired(start, secs)) {
                auto t0 = Clock::now();
                volatile uint64_t x = 0;
                while (since(t0) < 0.02 * share) x = x * 6364136223846793005ULL + 1;
                if (share < 1) nap(0.02 * (1 - share));
            }
        });
    }
    for (auto& t : ts) t.join();
}

// One line of status for whoever watches the task, written atomically.
void note(const std::string& text) {
    static const std::string path = env_s("BORG_NOTE");
    if (path.empty()) return;
    std::string tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::trunc);
        f << text;
    }
    std::rename(tmp.c_str(), path.c_str());
}

int run_service(const json& w) {
    auto start = Clock::now();
    auto mem = touch(20);
    const std::string task = env_s("BORG_TASK", "task"), machine = env_s("BORG_MACHINE", "?");
    const int port = std::atoi(env_s("BORG_PORT", "0").c_str());
    const double unhealthy_after = w.value("unhealthy_after", 0.0), hang_after = w.value("hang_after", 0.0);
    if (w.value("crash_on", "") == machine) {  // a task::machine pairing that always crashes (§4)
        nap(1.5);
        std::fprintf(stderr, "worker: this build crashes on %s\n", machine.c_str());
        return 1;
    }

    std::atomic<int> health{0};  // 0 healthy, 1 answers HTTP 500, 2 does not answer
    std::atomic<long> served{0};
    httplib::Server svr;
    if (port > 0) {
        svr.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
            int h = health.load();
            if (h == 2) nap(30);
            if (h != 0) res.status = 500;
            res.set_content(h == 0 ? "ok\n" : "sick\n", "text/plain");
        });
        const std::string shared = env_s("BORG_ALLOC_DIR");
        svr.Get("/", [&, shared](const httplib::Request&, httplib::Response& res) {
            served++;
            if (!shared.empty()) {
                std::ofstream log(shared + "/access.log", std::ios::app);
                log << "GET / served by " << task << "\n";
            }
            res.set_content("hello from " + task + " on " + machine + "\n", "text/plain");
        });
        auto set_health = [&](int h) {
            return [&health, h](const httplib::Request&, httplib::Response& res) {
                health = h;
                res.set_content("ok\n", "text/plain");
            };
        };
        svr.Get("/admin/sick", set_health(1));
        svr.Get("/admin/hang", set_health(2));
        svr.Get("/admin/ok", set_health(0));
        svr.Get("/load", [](const httplib::Request& req, httplib::Response& res) {
            double cores = req.has_param("cpu") ? std::atof(req.get_param_value("cpu").c_str()) : 1.0;
            double secs = req.has_param("secs") ? std::atof(req.get_param_value("secs").c_str()) : 20.0;
            cores = std::min(16.0, std::max(0.05, cores));
            secs = std::min(600.0, std::max(1.0, secs));
            std::thread(burn, cores, secs).detach();
            res.set_content("ok\n", "text/plain");
        });
        svr.Get("/mem", [](const httplib::Request& req, httplib::Response& res) {
            size_t mb = req.has_param("mb") ? static_cast<size_t>(std::atoi(req.get_param_value("mb").c_str())) : 50;
            double secs = req.has_param("secs") ? std::atof(req.get_param_value("secs").c_str()) : 20.0;
            mb = std::min<size_t>(4096, std::max<size_t>(1, mb));
            std::thread([mb, secs] {
                auto blocks = touch(mb);
                nap(std::min(600.0, std::max(1.0, secs)));
                for (char* p : blocks) std::free(p);
            }).detach();
            res.set_content("ok\n", "text/plain");
        });
        std::thread([&svr, port] {
            // The port may still be held for a moment by the task that had it before.
            for (int i = 0; i < 50; ++i) {
                if (svr.listen("0.0.0.0", port)) return;
                nap(0.2);
            }
            std::fprintf(stderr, "worker: cannot listen on port %d\n", port);
        }).detach();
    }

    long last = -1;
    while (true) {
        std::atomic<bool> stop{false};
        std::thread t(spin, std::ref(stop));
        nap(0.03);
        stop = true;
        t.join();
        nap(0.3);
        double age = since(start);
        if (hang_after > 0 && age >= hang_after) health = 2;
        else if (unhealthy_after > 0 && age >= unhealthy_after && health == 0) health = 1;
        if (port > 0 && served != last) {
            last = served;
            note("port " + std::to_string(port) + " · served " + std::to_string(last) + " request(s)");
        }
    }
}

// Calls the tasks of another job by name. The name service is asked again every 2 s, so the
// client keeps working when those tasks move to other machines (§2.6).
int run_client(const json& w) {
    auto start = Clock::now();
    const std::string target = w.value("target", "");
    const double rps = std::min(50.0, std::max(0.2, w.value("rps", 2.0)));
    const double duration = w.value("duration", 0.0);
    const std::string borglet = env_s("BORG_BORGLET", "http://127.0.0.1:9090");
    struct Endpoint {
        std::string name, ip;
        int port;
    };
    std::vector<Endpoint> endpoints;
    auto looked_up = Clock::now() - std::chrono::hours(1);
    long ok = 0, failed = 0;
    size_t next = 0;
    std::string last = "nothing yet";
    while (!expired(start, duration)) {
        if (since(looked_up) > 2) {
            looked_up = Clock::now();
            httplib::Client ns(borglet);
            ns.set_connection_timeout(1, 0);
            ns.set_read_timeout(2, 0);
            auto r = ns.Get("/bns?job=" + target);
            json reply = (r && r->status == 200) ? json::parse(r->body, nullptr, false) : json();
            if (reply.is_object()) {
                endpoints.clear();
                for (const auto& e : reply.value("names", json::array()))
                    if (e.value("healthy", false))
                        endpoints.push_back({e.value("name", ""), e.value("ip", ""), e.value("port", 0)});
            }
        }
        if (endpoints.empty()) {
            failed++;
            last = "no healthy task of " + target;
        } else {
            const Endpoint& e = endpoints[next++ % endpoints.size()];
            httplib::Client c(e.ip, e.port);
            c.set_connection_timeout(1, 0);
            c.set_read_timeout(1, 0);
            auto r = c.Get("/");
            if (r && r->status == 200) {
                ok++;
                last = e.name + " at " + e.ip + ":" + std::to_string(e.port);
            } else {
                failed++;
                last = e.name + " did not answer";
                looked_up = Clock::now() - std::chrono::hours(1);  // look the name up again
            }
        }
        note("ok " + std::to_string(ok) + " · failed " + std::to_string(failed) + " · last: " + last);
        nap(1.0 / rps);
    }
    return 0;
}

}  // namespace

int run_worker(int argc, char** argv) {
    // argv: borglet --worker <type>
    if (argc < 3) return 2;
    std::string type = argv[2];
    json w = json::parse(env_s("BORG_WORKLOAD", "{}"), nullptr, false);
    if (!w.is_object()) w = json::object();
    const double secs = w.value("duration", 0.0);
    auto start = Clock::now();
    auto wait = [&] {
        while (!expired(start, secs)) nap(0.2);
    };

    if (type == "service") return run_service(w);
    if (type == "logsaver") {
        const std::string shared = env_s("BORG_ALLOC_DIR");
        if (shared.empty()) {
            note("not in an alloc: there is no shared directory to read");
            wait();
            return 0;
        }
        long saved = 0;
        while (!expired(start, secs)) {
            std::ifstream log(shared + "/access.log");
            long lines = 0;
            for (std::string line; std::getline(log, line);) lines++;
            if (lines != saved) saved = lines;
            note("saved " + std::to_string(saved) + " log line(s) of the server in this alloc");
            nap(1);
        }
        return 0;
    }
    if (type == "client") return run_client(w);
    if (type == "sleep") {
        wait();
        return 0;
    }
    if (type == "cpu") {
        int threads = std::max(1, w.value("threads", 1));
        auto mem = touch(10);
        std::atomic<bool> stop{false};
        std::vector<std::thread> ts;
        for (int i = 0; i < threads; ++i) ts.emplace_back(spin, std::ref(stop));
        wait();
        stop = true;
        for (auto& t : ts) t.join();
        return 0;
    }
    if (type == "mem") {
        size_t target = static_cast<size_t>(std::max(1, w.value("mb", 100)));
        std::vector<char*> blocks;
        while (blocks.size() < target) {  // ~80 MB/s so the growth is visible in the UI
            blocks = touch(std::min<size_t>(8, target - blocks.size()), std::move(blocks));
            nap(0.1);
        }
        wait();
        return 0;
    }
    if (type == "disk") {
        size_t target = static_cast<size_t>(std::max(1, w.value("mb", 50)));
        std::vector<char> block(1 << 20, 'x');
        std::ofstream f("data.bin", std::ios::binary | std::ios::trunc);
        for (size_t i = 0; i < target && f; ++i) {  // ~20 MB/s
            f.write(block.data(), static_cast<std::streamsize>(block.size()));
            f.flush();
            note("wrote " + std::to_string(i + 1) + " MB");
            nap(0.05);
        }
        wait();
        return 0;
    }
    if (type == "crash") {
        const std::string only_on = w.value("only_on", "");
        auto mem = touch(5);
        if (!only_on.empty() && only_on != env_s("BORG_MACHINE")) {  // fine on every other machine
            while (true) nap(1);
        }
        while (!expired(start, secs > 0 ? secs : 2)) nap(0.2);
        std::fprintf(stderr, "worker: simulated crash\n");
        return 1;
    }
    std::fprintf(stderr, "worker: unknown type %s\n", type.c_str());
    return 2;
}
