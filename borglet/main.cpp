// borglet: the per-machine agent (§3.3). Starts and stops tasks, enforces their limits with
// cgroup v2, checks their health, and reports state + usage when the Borgmaster polls it.
//
// HTTP API (called by the Borgmaster):
//   POST   /tasks         start a task {id, attempt, job, index, user, package, cpu, ram_mb,
//                         disk_mb, ports, priority, appclass, slack_cpu, health, alloc, workload}.
//                         A "task" with workload type "alloc" is an alloc (§2.4): no process,
//                         just a reserved slice of the machine (a parent cgroup and a shared
//                         directory) in which the tasks that name it in `alloc` run
//   DELETE /tasks/<id>    stop a task (SIGTERM, then SIGKILL after a grace period); stopping an
//                         alloc stops the tasks inside it
//   GET    /status        machine + task state and usage
//   POST   /tasks/<id>/exec  {cmd}: run a shell command inside the task's jail and cgroup, like
//                         borgssh (§6.1). Only where tasks are jailed (see below)
//   POST   /admin/fail    simulate a machine failure: kill everything, go silent for N seconds
// and by tasks on this machine:
//   GET    /bns?job=<j>   where the tasks of a job are now (asks the Borgmaster's name service, §2.6)
//
// What the Borglet does on its own (§6.2):
//   - health: polls GET /health on every task that has one; 3 failures in a row stop the task
//   - CPU: latency-sensitive tasks get large cpu.weight shares, batch tasks tiny ones, so when
//     a machine is busy the kernel serves the services first. A task started with slack_cpu
//     has no hard cap and may use idle CPU beyond its limit; the others are capped at it
//   - memory: a task over its own limit is OOM-killed; if the whole machine runs out, tasks are
//     stopped from the lowest priority up
//   - disk: a task that writes more than its disk limit is stopped
//   - security (§6.1), with BORGLET_CHROOT=1 on Linux: every task runs in a chroot jail as an
//     unprivileged user. The jail holds read-only views of the system directories the program
//     needs, the task's own directory at /task, and its alloc's shared directory at /alloc
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/mount.h>
#endif

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "cgroups.h"
#include "httplib.h"
#include "json.hpp"

int run_worker(int argc, char** argv);

using json = nlohmann::json;
using borglet::Cgroups;
namespace fs = std::filesystem;

namespace {

constexpr int kHealthFailures = 3;      // failed health checks in a row before a task is stopped
constexpr double kHealthEvery = 2;      // seconds between health checks of one task
constexpr double kHealthGrace = 4;      // seconds after start before failures count
constexpr double kSaturated = 0.92;     // CPU use (share of the machine) that counts as contention
constexpr double kMemoryFull = 0.97;    // memory use (share of the machine) that triggers evictions

double now_s() {
    return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string env(const char* name, const std::string& def) {
    const char* v = std::getenv(name);
    return v && *v ? v : def;
}

struct Config {
    std::string name;
    int port = 9090;
    std::string master = "http://localhost:8080";  // one URL, or several replicas separated by commas
    std::vector<std::string> masters;
    std::string advertise;  // how the master reaches us
    double cpu = 1;
    int64_t ram_mb = 512;
    int64_t disk_mb = 2048;
    int port_lo = 20000, port_hi = 20031;  // TCP ports Borg may hand out to tasks (§2.3)
    std::map<std::string, std::string> attrs;
    double install_secs = 2;  // simulated package download on first use (§3.2 package locality)
    std::string dir = "/var/borg";  // task directories live in <dir>/tasks
    bool jail = false;              // run every task in a chroot jail (§6.1); Linux only
};

constexpr uid_t kNobody = 65534;  // the unprivileged user that jailed tasks run as

struct LocalTask {
    int64_t id = 0;
    int64_t attempt = 0;
    std::string job, user, package;
    int index = 0;
    double cpu = 0;
    int64_t ram_mb = 0, disk_mb = 0;
    int priority = 0;
    bool latency_sensitive = false;  // appclass (§6.2)
    bool slack_cpu = true;
    bool health = false;  // check GET /health on its first port
    std::vector<int> ports;
    int64_t alloc = 0;      // the alloc this task runs in (0 = none)
    bool is_alloc = false;  // this entry is an alloc, not a process
    json workload;

    std::string state;  // installing, running, finished, failed, oom, killed, evicted
    std::string detail;
    int exit_code = 0;
    pid_t pid = -1;
    std::string cgroup, dir;
    std::string jail;                  // root of its chroot jail ("" = not jailed)
    std::vector<std::string> mounts;   // what is mounted inside the jail, in mount order
    double start_at = 0, started = 0, ended = 0;
    bool kill_requested = false;
    double kill_deadline = 0;
    std::string stop_state;  // state to report instead of "killed" when the Borglet stopped it itself

    uint64_t last_cpu_usec = 0;
    double last_sample = 0;
    double cpu_usage = 0;  // cores
    double mem_mb = 0, disk_used_mb = 0;
    double last_disk_check = 0;
    bool capped = false;  // slack task currently held to its CPU limit

    int healthy = -1;  // -1 unknown, 0 failing, 1 healthy
    int health_failures = 0;
    double last_health = 0;
    std::string note;

    bool terminal() const {
        return state == "finished" || state == "failed" || state == "oom" || state == "killed" || state == "evicted";
    }
};

class Borglet {
public:
    Borglet(Config cfg, std::string self_exe) : cfg_(std::move(cfg)), self_exe_(std::move(self_exe)) {}

    void run() {
        std::string why;
        if (cgroups_.init(&why)) std::cout << "borglet: cgroup v2 isolation enabled" << std::endl;
        else std::cout << "borglet: WARNING running without cgroups: " << why << std::endl;
        std::error_code ec;
        fs::remove_all(cfg_.dir + "/tasks", ec);
        fs::create_directories(cfg_.dir + "/tasks", ec);

        std::thread([this] { monitor_loop(); }).detach();
        std::thread([this] { health_loop(); }).detach();
        std::thread([this] { register_loop(); }).detach();

        httplib::Server svr;
        svr.set_pre_routing_handler([this](const httplib::Request&, httplib::Response& res) {
            if (offline()) {
                res.status = 503;
                return httplib::Server::HandlerResponse::Handled;
            }
            return httplib::Server::HandlerResponse::Unhandled;
        });
        svr.Get("/status", [this](const httplib::Request&, httplib::Response& res) {
            res.set_content(status().dump(), "application/json");
        });
        svr.Post("/tasks", [this](const httplib::Request& req, httplib::Response& res) {
            auto body = json::parse(req.body, nullptr, false);
            if (body.is_discarded() || !body.contains("id")) {
                res.status = 400;
                return;
            }
            start_task(body);
            res.set_content(R"({"ok":true})", "application/json");
        });
        svr.Delete(R"(/tasks/(\d+))", [this](const httplib::Request& req, httplib::Response& res) {
            kill_task(std::stoll(req.matches[1].str()), "killed by master");
            res.set_content(R"({"ok":true})", "application/json");
        });
        svr.Post(R"(/tasks/(\d+)/exec)", [this](const httplib::Request& req, httplib::Response& res) {
            auto body = json::parse(req.body, nullptr, false);
            int status = 200;
            json out = exec_in_task(std::stoll(req.matches[1].str()),
                                    body.is_object() ? body.value("cmd", "") : std::string(), &status);
            res.status = status;
            res.set_content(out.dump(), "application/json");
        });
        svr.Post("/admin/fail", [this](const httplib::Request& req, httplib::Response& res) {
            auto body = json::parse(req.body, nullptr, false);
            double secs = body.is_object() ? body.value("seconds", 20.0) : 20.0;
            res.set_content(R"({"ok":true})", "application/json");
            fail(secs);
        });
        svr.Get("/bns", [this](const httplib::Request& req, httplib::Response& res) {
            res.set_content(lookup(req.has_param("job") ? req.get_param_value("job") : ""), "application/json");
        });
        svr.Get("/healthz", [](const httplib::Request&, httplib::Response& res) { res.set_content("ok", "text/plain"); });

        std::cout << "borglet " << cfg_.name << " listening on :" << cfg_.port << " (cpu " << cfg_.cpu
                  << ", ram " << cfg_.ram_mb << " MB, disk " << cfg_.disk_mb << " MB, ports " << cfg_.port_lo << "-"
                  << cfg_.port_hi << "), master " << cfg_.master << std::endl;
        svr.listen("0.0.0.0", cfg_.port);
    }

private:
    bool offline() const { return now_s() < offline_until_.load(); }

    json status() {
        std::lock_guard<std::mutex> g(mu_);
        last_poll_ = now_s();
        json tasks = json::array();
        double cpu = 0, mem = 0;
        for (const auto& [id, t] : tasks_) {
            tasks.push_back({{"id", t.id},
                             {"attempt", t.attempt},
                             {"state", t.state},
                             {"detail", t.detail},
                             {"exit_code", t.exit_code},
                             {"pid", t.pid},
                             {"cpu_usage", t.cpu_usage},
                             {"mem_mb", t.mem_mb},
                             {"disk_mb", t.disk_used_mb},
                             {"healthy", t.healthy},
                             {"capped", t.capped},
                             {"jailed", !t.jail.empty()},
                             {"note", t.note}});
            if (!t.terminal() && !t.is_alloc) {
                cpu += t.cpu_usage;
                mem += t.mem_mb;
            }
        }
        return {{"name", cfg_.name},
                {"capacity", {{"cpu", cfg_.cpu}, {"ram", cfg_.ram_mb}, {"disk", cfg_.disk_mb}}},
                {"attributes", cfg_.attrs},
                {"cgroups", cgroups_.enabled()},
                {"packages", packages_},
                {"usage", {{"cpu", cpu}, {"ram", mem}}},
                {"cpu_contended", contended_},
                {"tasks", tasks}};
    }

    void start_task(const json& b) {
        std::lock_guard<std::mutex> g(mu_);
        int64_t id = b["id"].get<int64_t>();
        int64_t attempt = b.value("attempt", 0LL);
        auto it = tasks_.find(id);
        if (it != tasks_.end()) {
            if (!it->second.terminal() && it->second.attempt == attempt) return;  // duplicate request
            if (!it->second.terminal()) kill_locked(it->second, "replaced by a newer attempt");
            cleanup_locked(it->second);
        }
        LocalTask t;
        t.id = id;
        t.attempt = attempt;
        t.job = b.value("job", "");
        t.index = b.value("index", 0);
        t.user = b.value("user", "");
        t.package = b.value("package", t.job);
        t.cpu = b.value("cpu", 0.1);
        t.ram_mb = b.value("ram_mb", 64LL);
        t.disk_mb = b.value("disk_mb", 0LL);
        t.priority = b.value("priority", 0);
        t.latency_sensitive = b.value("appclass", "batch") == "ls";
        t.slack_cpu = b.value("slack_cpu", false);
        t.health = b.value("health", false);
        t.alloc = b.value("alloc", 0LL);
        for (const auto& p : b.value("ports", json::array())) t.ports.push_back(p.get<int>());
        t.workload = b.value("workload", json::object());
        if (t.workload.value("type", "") == "alloc") {  // reserve the slice; nothing to install or run
            t.is_alloc = true;
            t.cgroup = cgroups_.create_alloc(std::to_string(id), t.cpu, t.ram_mb * 1024 * 1024);
            t.dir = cfg_.dir + "/allocs/" + std::to_string(id) + "-" + std::to_string(attempt);
            std::error_code ec;
            fs::create_directories(t.dir, ec);
            t.state = "running";
            t.started = now_s();
            t.detail = "reserved " + std::to_string(t.cpu).substr(0, 4) + " cpu and " + std::to_string(t.ram_mb) + " MB";
            tasks_[id] = std::move(t);
            return;
        }
        bool cached = packages_.count(t.package) > 0;
        t.state = cached ? "running" : "installing";
        t.start_at = now_s() + (cached ? 0 : cfg_.install_secs);
        t.detail = cached ? "package cached" : "installing package " + t.package;
        tasks_[id] = std::move(t);
    }

    void kill_task(int64_t id, const std::string& why) {
        std::lock_guard<std::mutex> g(mu_);
        auto it = tasks_.find(id);
        if (it != tasks_.end()) kill_locked(it->second, why);
    }

    // Stops a task: SIGTERM now, SIGKILL after a grace period (§2.3). `stop_state` is what the
    // task is reported as afterwards when the Borglet itself decided to stop it.
    void kill_locked(LocalTask& t, const std::string& why, const std::string& stop_state = "") {
        if (t.terminal()) return;
        if (t.is_alloc) {
            release_alloc_locked(t, why);
            return;
        }
        t.detail = why;
        if (!stop_state.empty()) t.stop_state = stop_state;
        if (t.pid <= 0) {  // still installing
            t.state = t.stop_state.empty() ? "killed" : t.stop_state;
            t.ended = now_s();
            return;
        }
        if (t.kill_requested) return;
        t.kill_requested = true;
        t.kill_deadline = now_s() + 3;  // grace period after SIGTERM
        ::kill(-t.pid, SIGTERM);
    }

    void cleanup_locked(LocalTask& t) {
        if (t.is_alloc) {
            if (!t.terminal()) release_alloc_locked(t, "replaced");
            return;
        }
        if (t.pid > 0) {
            ::kill(-t.pid, SIGKILL);
            ::waitpid(t.pid, nullptr, 0);
            t.pid = -1;
        }
        cgroups_.remove(t.cgroup);
        t.cgroup.clear();
        remove_jail(t);
        if (!t.dir.empty()) {
            std::error_code ec;
            fs::remove_all(t.dir, ec);
            t.dir.clear();
        }
    }

    // ---- chroot jails (§6.1) -----------------------------------------------------------------

    // Builds the task's jail: read-only views of the system directories its program needs, its
    // own directory at /task and, inside an alloc, the alloc's shared directory at /alloc.
    // Returns false (and leaves no jail) if anything fails; the task then runs without one.
    bool make_jail(LocalTask& t, const std::string& alloc_dir) {
#if defined(__linux__)
        std::error_code ec;
        std::string root = cfg_.dir + "/jails/" + std::to_string(t.id) + "-" + std::to_string(t.attempt);
        fs::create_directories(root, ec);
        if (ec) return false;
        t.jail = root;
        auto bind = [&](const std::string& from, const std::string& at, bool read_only) {
            std::string to = root + at;
            if (::mkdir(to.c_str(), 0755) != 0 && errno != EEXIST) return false;
            if (::mount(from.c_str(), to.c_str(), nullptr, MS_BIND | MS_REC, nullptr) != 0) return false;
            t.mounts.push_back(to);
            return !read_only || ::mount(nullptr, to.c_str(), nullptr, MS_BIND | MS_REMOUNT | MS_RDONLY, nullptr) == 0;
        };
        bool ok = true;
        for (const char* sys : {"/usr", "/bin", "/sbin", "/lib", "/lib64"})
            if (fs::exists(sys, ec)) ok = ok && bind(sys, sys, true);
        ok = ok && ::chown(t.dir.c_str(), kNobody, kNobody) == 0 && bind(t.dir, "/task", false);
        if (ok && !alloc_dir.empty()) {
            ::chmod(alloc_dir.c_str(), 0777);
            ok = bind(alloc_dir, "/alloc", false);
        }
        if (!ok) remove_jail(t);
        return ok;
#else
        (void)t;
        (void)alloc_dir;
        return false;
#endif
    }

    // Takes a jail down: unmounts what was mounted in it and removes the empty directories.
    // Nothing is ever deleted recursively here, so a mount that will not go away is left alone.
    void remove_jail(LocalTask& t) {
#if defined(__linux__)
        for (auto it = t.mounts.rbegin(); it != t.mounts.rend(); ++it) {
            ::umount2(it->c_str(), MNT_DETACH);
            ::rmdir(it->c_str());
        }
        if (!t.jail.empty()) ::rmdir(t.jail.c_str());
#endif
        t.mounts.clear();
        t.jail.clear();
    }

    // Runs a shell command inside a running task's jail and cgroup, as the same unprivileged
    // user, and returns what it printed (§6.1: borgssh). Refused when tasks are not jailed:
    // the command would otherwise run on the machine itself.
    json exec_in_task(int64_t id, const std::string& cmd, int* status) {
        std::string jail, procs;
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = tasks_.find(id);
            if (it == tasks_.end() || it->second.pid <= 0 || it->second.terminal()) {
                *status = 404;
                return {{"error", "that task is not running on this machine"}};
            }
            jail = it->second.jail;
            procs = it->second.cgroup.empty() ? "" : it->second.cgroup + "/cgroup.procs";
        }
        if (jail.empty()) {
            *status = 501;
            return {{"error", "exec needs jailed tasks: run the Borglets on Linux with BORGLET_CHROOT=1"}};
        }
        if (cmd.empty() || cmd.size() > 2000) {
            *status = 400;
            return {{"error", "cmd must be a shell command of at most 2000 characters"}};
        }
        int fds[2];
        if (::pipe(fds) != 0) {
            *status = 500;
            return {{"error", "pipe failed"}};
        }
        std::string sh = "sh", flag = "-c", command = cmd, path = "PATH=/usr/local/bin:/usr/bin:/bin";
        char* argv[] = {sh.data(), flag.data(), command.data(), nullptr};
        char* envp[] = {path.data(), nullptr};
        pid_t pid = ::fork();
        if (pid == 0) {  // only async-signal-safe calls from here to exec
            ::setpgid(0, 0);
            if (!procs.empty()) Cgroups::join(procs.c_str());
            if (::chroot(jail.c_str()) != 0 || ::chdir("/task") != 0) _exit(125);
            if (::setgid(kNobody) != 0 || ::setuid(kNobody) != 0) _exit(124);
            ::dup2(fds[1], 1);
            ::dup2(fds[1], 2);
            ::close(fds[0]);
            ::close(fds[1]);
            ::execve("/bin/sh", argv, envp);
            _exit(127);
        }
        ::close(fds[1]);
        if (pid < 0) {
            ::close(fds[0]);
            *status = 500;
            return {{"error", "fork failed"}};
        }
        std::string output;
        double deadline = now_s() + 3;
        bool timed_out = false;
        char buf[4096];
        while (true) {
            double left = deadline - now_s();
            if (left <= 0) {
                timed_out = true;
                break;
            }
            struct pollfd p = {fds[0], POLLIN, 0};
            if (::poll(&p, 1, static_cast<int>(left * 1000)) <= 0) continue;
            ssize_t n = ::read(fds[0], buf, sizeof buf);
            if (n <= 0) break;
            if (output.size() < 8192) output.append(buf, static_cast<size_t>(n));
        }
        ::close(fds[0]);
        if (timed_out) ::kill(-pid, SIGKILL);
        int st = 0;
        ::waitpid(pid, &st, 0);
        if (output.size() > 8192) output.resize(8192);
        return {{"ok", !timed_out && WIFEXITED(st) && WEXITSTATUS(st) == 0},
                {"exit_code", WIFEXITED(st) ? WEXITSTATUS(st) : -1},
                {"timed_out", timed_out},
                {"output", output}};
    }

    // Releases an alloc: the tasks inside it are stopped at once and reported as evicted, so the
    // Borgmaster reschedules them together with the alloc.
    void release_alloc_locked(LocalTask& a, const std::string& why) {
        for (auto& [tid, t] : tasks_) {
            if (t.alloc != a.id || t.is_alloc) continue;
            if (!t.terminal()) {
                t.state = "evicted";
                t.detail = "moved: its alloc was released on " + cfg_.name;
                t.ended = now_s();
            }
            cleanup_locked(t);
        }
        cgroups_.remove(a.cgroup);
        a.cgroup.clear();
        std::error_code ec;
        fs::remove_all(a.dir, ec);
        a.state = "killed";
        a.detail = why;
        a.ended = now_s();
    }

    void fail(double secs) {
        std::cout << "borglet: simulating machine failure for " << secs << "s" << std::endl;
        offline_until_ = now_s() + secs;
        std::lock_guard<std::mutex> g(mu_);
        for (auto& [id, t] : tasks_)
            if (!t.is_alloc) cleanup_locked(t);
        for (auto& [id, t] : tasks_)
            if (t.is_alloc) cgroups_.remove(t.cgroup);
        tasks_.clear();
        packages_.clear();  // a "rebooted" machine has a cold package cache
        registered_ = false;
    }

    // Share of the CPU a task gets when the machine is busy: latency-sensitive tasks get large
    // shares in proportion to their limit, batch tasks tiny ones (§6.2).
    static int cpu_weight(const LocalTask& t) {
        double w = t.cpu * (t.latency_sensitive ? 1000.0 : 10.0);
        return std::min(10000, std::max(1, static_cast<int>(w + 0.5)));
    }

    void launch_locked(LocalTask& t) {
        std::string type = t.workload.value("type", "service");
        std::vector<std::string> args = {self_exe_, "--worker", type};

        std::error_code ec;
        t.dir = cfg_.dir + "/tasks/" + std::to_string(t.id) + "-" + std::to_string(t.attempt);
        fs::create_directories(t.dir, ec);
        std::string ports;
        for (int p : t.ports) ports += (ports.empty() ? "" : ",") + std::to_string(p);
        std::vector<std::string> envs = {
            "BORG_WORKLOAD=" + t.workload.dump(),
            "BORG_TASK=" + t.job + "/" + std::to_string(t.index),
            "BORG_JOB=" + t.job,
            "BORG_INDEX=" + std::to_string(t.index),
            "BORG_USER=" + t.user,
            "BORG_MACHINE=" + cfg_.name,
            "BORG_PORTS=" + ports,
            "BORG_PORT=" + (t.ports.empty() ? std::string() : std::to_string(t.ports[0])),
            "BORG_BORGLET=http://127.0.0.1:" + std::to_string(cfg_.port),
            "BORG_NOTE=" + t.dir + "/.note",
        };

        std::string parent, alloc_dir;
        if (t.alloc) {  // run inside the alloc: under its cgroup, and with its shared directory
            auto a = tasks_.find(t.alloc);
            if (a != tasks_.end() && a->second.is_alloc && !a->second.terminal()) {
                parent = a->second.cgroup;
                alloc_dir = a->second.dir;
            }
        }
        const bool jailed = cfg_.jail && make_jail(t, alloc_dir);
        if (jailed) envs.back() = "BORG_NOTE=/task/.note";  // the same file, as the task sees it
        if (!alloc_dir.empty()) envs.push_back("BORG_ALLOC_DIR=" + (jailed ? std::string("/alloc") : alloc_dir));
        const std::string jail = t.jail;
        Cgroups::Limits limits;
        limits.cpu_cores = t.cpu;
        limits.ram_bytes = t.ram_mb * 1024 * 1024;
        limits.weight = cpu_weight(t);
        limits.cap_cpu = !t.slack_cpu;
        t.cgroup = cgroups_.create(std::to_string(t.id), limits, parent);
        t.capped = false;
        std::string procs = t.cgroup.empty() ? "" : t.cgroup + "/cgroup.procs";
        std::vector<char*> argv, envp;
        for (auto& a : args) argv.push_back(a.data());
        argv.push_back(nullptr);
        for (auto& e : envs) envp.push_back(e.data());
        envp.push_back(nullptr);

        pid_t pid = ::fork();
        if (pid == 0) {  // only async-signal-safe calls from here to exec
            ::setpgid(0, 0);
            if (!procs.empty() && !Cgroups::join(procs.c_str())) _exit(126);
            if (jailed) {  // into the jail, then drop root so there is no way back out
                if (::chroot(jail.c_str()) != 0 || ::chdir("/task") != 0) _exit(125);
                if (::setgid(kNobody) != 0 || ::setuid(kNobody) != 0) _exit(124);
            } else if (::chdir(t.dir.c_str()) != 0) {
                _exit(125);
            }
            ::execve(self_exe_.c_str(), argv.data(), envp.data());
            _exit(127);
        }
        if (pid < 0) {
            t.state = "failed";
            t.detail = "fork failed";
            t.ended = now_s();
            return;
        }
        ::setpgid(pid, pid);
        t.pid = pid;
        t.state = "running";
        t.started = now_s();
        t.detail = cgroups_.enabled() ? "running in " + t.cgroup : "running (no cgroups)";
        if (jailed) t.detail += ", jailed in " + t.jail;
    }

    void monitor_loop() {
        while (true) {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            std::lock_guard<std::mutex> g(mu_);
            double now = now_s();
            for (auto it = tasks_.begin(); it != tasks_.end();) {
                LocalTask& t = it->second;
                if (t.is_alloc) {
                    t.cpu_usage = t.mem_mb = 0;
                    for (const auto& [oid, o] : tasks_) {
                        if (o.alloc != t.id || o.is_alloc || o.pid <= 0) continue;
                        t.cpu_usage += o.cpu_usage;
                        t.mem_mb += o.mem_mb;
                    }
                    if (t.terminal() && now - t.ended > 120) it = tasks_.erase(it);
                    else ++it;
                    continue;
                }
                if (!t.terminal() && t.pid < 0 && now >= t.start_at) {
                    packages_.insert(t.package);
                    launch_locked(t);
                }
                if (t.pid > 0) {
                    int st = 0;
                    if (::waitpid(t.pid, &st, WNOHANG) == t.pid) on_exit_locked(t, st);
                    else if (t.kill_requested && now > t.kill_deadline) ::kill(-t.pid, SIGKILL);
                }
                if (t.pid > 0 && now - t.last_sample >= 0.5) sample_locked(t, now);
                if (t.pid > 0 && now - t.last_disk_check >= 2) check_disk_locked(t, now);
                // Keep finished tasks around long enough for the master to see them.
                if (t.terminal() && now - t.ended > 120) {
                    cleanup_locked(t);
                    it = tasks_.erase(it);
                    continue;
                }
                ++it;
            }
            control_locked(now);
        }
    }

    void on_exit_locked(LocalTask& t, int st) {
        Cgroups::Stats s;
        cgroups_.stats(t.cgroup, &s);
        t.pid = -1;
        t.ended = now_s();
        t.cpu_usage = 0;
        t.mem_mb = 0;
        t.healthy = -1;
        if (!t.stop_state.empty()) {
            t.state = t.stop_state;  // the Borglet stopped it: unhealthy, over a limit, evicted
        } else if (t.kill_requested) {
            t.state = "killed";
        } else if (s.oom_kills > 0) {
            t.state = "oom";
            t.detail = "OOM-killed: exceeded memory limit of " + std::to_string(t.ram_mb) + " MB";
        } else if (WIFEXITED(st) && WEXITSTATUS(st) == 0) {
            t.state = "finished";
            t.detail = "exited 0";
        } else {
            t.state = "failed";
            t.exit_code = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
            t.detail = WIFEXITED(st) ? "exited " + std::to_string(WEXITSTATUS(st))
                                     : "killed by signal " + std::to_string(WTERMSIG(st));
        }
        cgroups_.remove(t.cgroup);
        t.cgroup.clear();
        remove_jail(t);
    }

    void sample_locked(LocalTask& t, double now) {
        Cgroups::Stats s;
        bool from_cgroup = cgroups_.stats(t.cgroup, &s);
        if (!from_cgroup && !Cgroups::proc_stats(t.pid, &s)) return;
        if (t.last_sample > 0 && s.cpu_usec >= t.last_cpu_usec && now > t.last_sample) {
            double cores = (s.cpu_usec - t.last_cpu_usec) / 1e6 / (now - t.last_sample);
            t.cpu_usage = t.cpu_usage > 0 ? 0.5 * t.cpu_usage + 0.5 * cores : cores;  // light smoothing
        }
        t.last_cpu_usec = s.cpu_usec;
        t.last_sample = now;
        t.mem_mb = s.mem_bytes / (1024.0 * 1024.0);
        // Without cgroups the limit is checked after the fact, as early Borglets did (§6.2).
        if (!from_cgroup && t.mem_mb > t.ram_mb && !t.kill_requested) {
            kill_locked(t, "OOM-killed: exceeded memory limit of " + std::to_string(t.ram_mb) + " MB", "oom");
            ::kill(-t.pid, SIGKILL);
        }
        std::ifstream f(t.dir + "/.note");
        std::string line;
        if (f && std::getline(f, line)) t.note = line.substr(0, 200);
    }

    void check_disk_locked(LocalTask& t, double now) {
        t.last_disk_check = now;
        std::error_code ec;
        uintmax_t bytes = 0;
        for (auto it = fs::recursive_directory_iterator(t.dir, ec); !ec && it != fs::recursive_directory_iterator();
             it.increment(ec)) {
            std::error_code e2;
            if (it->is_regular_file(e2)) bytes += it->file_size(e2);
        }
        t.disk_used_mb = bytes / (1024.0 * 1024.0);
        if (t.disk_mb > 0 && t.disk_used_mb > t.disk_mb && !t.kill_requested)
            kill_locked(t, "stopped: wrote " + std::to_string(static_cast<int>(t.disk_used_mb)) +
                               " MB, over its disk limit of " + std::to_string(t.disk_mb) + " MB", "failed");
    }

    // The Borglet's own control loop (§6.2), once a second.
    void control_locked(double now) {
        if (now - last_control_ < 1) return;
        last_control_ = now;
        double cpu = 0, mem = 0;
        for (const auto& [id, t] : tasks_) {
            if (t.pid <= 0) continue;
            cpu += t.cpu_usage;
            mem += t.mem_mb;
        }
        // CPU is compressible: nothing is killed. The kernel shares it out by cpu.weight, so
        // latency-sensitive tasks are served first and batch tasks on slack CPU give way at once.
        contended_ = cpu >= kSaturated * cfg_.cpu;
        // Memory is not compressible: if the machine itself runs out, stop tasks from the lowest
        // priority up until the rest fits. One task per second, so the numbers can catch up.
        if (mem > kMemoryFull * cfg_.ram_mb) {
            LocalTask* victim = nullptr;
            for (auto& [id, t] : tasks_) {
                if (t.pid <= 0 || t.kill_requested) continue;
                if (!victim || t.priority < victim->priority ||
                    (t.priority == victim->priority && t.mem_mb > victim->mem_mb))
                    victim = &t;
            }
            if (victim) {
                std::cout << "borglet: machine out of memory (" << static_cast<int>(mem) << " MB used), evicting "
                          << victim->job << "/" << victim->index << std::endl;
                kill_locked(*victim, "evicted: " + cfg_.name + " ran out of memory (lowest priority goes first)",
                            "evicted");
                ::kill(-victim->pid, SIGKILL);  // memory is needed now
            }
        }
    }

    // Health checks (§2.6): GET /health on every task that serves one.
    void health_loop() {
        struct Probe {
            int64_t id, attempt;
            int port;
        };
        while (true) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            if (offline()) continue;
            std::vector<Probe> probes;
            {
                std::lock_guard<std::mutex> g(mu_);
                double now = now_s();
                for (auto& [id, t] : tasks_) {
                    if (t.pid <= 0 || !t.health || t.ports.empty() || t.kill_requested) continue;
                    if (now - t.last_health < kHealthEvery) continue;
                    t.last_health = now;
                    probes.push_back({t.id, t.attempt, t.ports[0]});
                }
            }
            for (const Probe& p : probes) {
                httplib::Client cli("127.0.0.1", p.port);
                cli.set_connection_timeout(0, 500000);
                cli.set_read_timeout(1, 0);
                auto r = cli.Get("/health");
                bool ok = r && r->status == 200;
                std::string problem = !r ? "/health did not answer" : "/health returned HTTP " + std::to_string(r->status);
                std::lock_guard<std::mutex> g(mu_);
                auto it = tasks_.find(p.id);
                if (it == tasks_.end() || it->second.attempt != p.attempt || it->second.pid <= 0) continue;
                LocalTask& t = it->second;
                if (ok) {
                    t.healthy = 1;
                    t.health_failures = 0;
                    continue;
                }
                if (now_s() - t.started < kHealthGrace && t.healthy != 1) continue;  // still starting up
                t.healthy = 0;
                if (++t.health_failures >= kHealthFailures)
                    kill_locked(t, "unhealthy: " + problem + " " + std::to_string(kHealthFailures) + " times in a row",
                                "failed");
            }
        }
    }

    // Name lookups for tasks on this machine, answered by the Borgmaster's name service and
    // cached for a second.
    std::string lookup(const std::string& job) {
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = names_.find(job);
            if (it != names_.end() && now_s() - it->second.first < 1) return it->second.second;
        }
        auto r = master_call([&](httplib::Client& cli) { return cli.Get("/api/bns?job=" + job); });
        std::string body = (r && r->status == 200) ? r->body : R"({"names":[]})";
        std::lock_guard<std::mutex> g(mu_);
        names_[job] = {now_s(), body};
        return body;
    }

    // Sends a request to the Borgmaster: to the replica that answered last, else to the others in
    // turn. Any replica will do; one that is not the elected master passes the request on.
    httplib::Result master_call(const std::function<httplib::Result(httplib::Client&)>& send) {
        for (size_t i = 0; i < cfg_.masters.size(); ++i) {
            size_t k = (master_index_ + i) % cfg_.masters.size();
            httplib::Client cli(cfg_.masters[k]);
            cli.set_connection_timeout(1, 0);
            cli.set_read_timeout(2, 0);
            httplib::Result r = send(cli);
            if (r && r->status < 500) {
                master_index_ = k;
                return r;
            }
        }
        return httplib::Result();
    }

    void register_loop() {
        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(2));
            if (offline()) continue;
            {
                std::lock_guard<std::mutex> g(mu_);
                // Re-register if the master has not polled us for a while (e.g. it restarted).
                if (registered_ && now_s() - last_poll_ < 10) continue;
            }
            json body = {{"name", cfg_.name},   {"address", cfg_.advertise}, {"cpu", cfg_.cpu},
                         {"ram", cfg_.ram_mb},  {"disk", cfg_.disk_mb},      {"port_lo", cfg_.port_lo},
                         {"port_hi", cfg_.port_hi}, {"attributes", cfg_.attrs}};
            auto r = master_call([&](httplib::Client& cli) { return cli.Post("/api/register", body.dump(), "application/json"); });
            std::lock_guard<std::mutex> g(mu_);
            if (r && r->status == 200) {
                if (!registered_) std::cout << "borglet: registered with " << cfg_.master << std::endl;
                registered_ = true;
                last_poll_ = now_s();
            }
        }
    }

    Config cfg_;
    std::string self_exe_;
    Cgroups cgroups_;
    std::mutex mu_;
    std::map<int64_t, LocalTask> tasks_;
    std::set<std::string> packages_;
    std::map<std::string, std::pair<double, std::string>> names_;  // job -> (time, lookup reply)
    bool registered_ = false;
    bool contended_ = false;
    double last_poll_ = 0, last_control_ = 0;
    std::atomic<double> offline_until_{0};
    std::atomic<size_t> master_index_{0};
};

std::string self_exe_path(const char* argv0) {
    std::error_code ec;
    auto p = fs::read_symlink("/proc/self/exe", ec);
    if (!ec) return p.string();
    return fs::absolute(argv0, ec).string();
}

}  // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && std::string(argv[1]) == "--worker") return run_worker(argc, argv);
    ::signal(SIGPIPE, SIG_IGN);

    char host[256] = {0};
    ::gethostname(host, sizeof host - 1);
    Config cfg;
    cfg.name = env("BORGLET_NAME", host);
    cfg.port = std::stoi(env("BORGLET_PORT", "9090"));
    cfg.master = env("BORG_MASTER", "http://localhost:8080");
    std::stringstream master_list(cfg.master);
    for (std::string m; std::getline(master_list, m, ',');)
        if (!m.empty()) cfg.masters.push_back(m);
    cfg.cpu = std::stod(env("BORGLET_CPU", "1"));
    cfg.ram_mb = std::stoll(env("BORGLET_RAM_MB", "512"));
    cfg.disk_mb = std::stoll(env("BORGLET_DISK_MB", "2048"));
    cfg.install_secs = std::stod(env("BORGLET_INSTALL_SECS", "2"));
    cfg.dir = env("BORGLET_DIR", "/var/borg");
    cfg.jail = env("BORGLET_CHROOT", "0") == "1";
    std::string ports = env("BORGLET_PORTS", "20000-20031");
    auto dash = ports.find('-');
    if (dash != std::string::npos) {
        cfg.port_lo = std::stoi(ports.substr(0, dash));
        cfg.port_hi = std::stoi(ports.substr(dash + 1));
    }
    std::stringstream attrs(env("BORGLET_ATTRS", ""));
    std::string kv;
    while (std::getline(attrs, kv, ',')) {
        auto eq = kv.find('=');
        if (eq != std::string::npos) cfg.attrs[kv.substr(0, eq)] = kv.substr(eq + 1);
    }
    cfg.advertise = env("BORGLET_ADVERTISE", "http://" + cfg.name + ":" + std::to_string(cfg.port));

    Borglet(cfg, self_exe_path(argv[0])).run();
    return 0;
}
