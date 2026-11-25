// borgscheduler: the scheduler as a process of its own (§3.4).
//
// "A scheduler replica operates on a cached copy of the cell state. It repeatedly: retrieves
// state changes from the elected master (including both assigned and pending work); updates its
// local copy; does a scheduling pass to assign tasks; and informs the elected master of those
// assignments. The master will accept and apply these assignments unless they are inappropriate
// (e.g., based on out of date state), which will cause them to be reconsidered in the
// scheduler's next pass."
//
// That is this loop. It runs the same scheduler library (core/) as the Borgmaster would. Each
// assignment carries the version of the machine it was computed for; the Borgmaster rejects it
// if the machine has changed since (optimistic concurrency, as in Omega).
//
//   borgscheduler --master http://borgmaster:8080[,http://other-replica:8080...] [--interval 0.5]
//
// While this process keeps asking for state, the Borgmaster leaves scheduling to it; if it stops,
// the Borgmaster schedules by itself again after a few seconds.
#include <signal.h>

#include <chrono>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "borg/scheduler.h"
#include "httplib.h"
#include "json.hpp"

using json = nlohmann::json;
using namespace borg;

namespace {

Resources resources(const json& a) {
    std::vector<double> v = a.get<std::vector<double>>();
    v.resize(4);
    return {v[0], v[1], v[2], v[3]};
}

// Builds a cell from the cached copy of the Borgmaster's state.
Cell build_cell(const std::map<int64_t, json>& machines, const std::map<int64_t, json>& tasks) {
    Cell cell;
    for (const auto& [id, m] : machines) {
        MachineId mid = cell.add_machine(m.value("name", ""), resources(m["capacity"]),
                                         m.value("attributes", std::map<std::string, std::string>{}));
        Machine& mach = cell.machine(mid);
        for (const auto& p : m.value("packages", json::array())) mach.packages.insert(p.get<std::string>());
    }
    for (const auto& [id, o] : tasks) {
        Task t;
        t.id = id;
        t.job = o.value("job", JobId{0});
        t.index = o.value("index", 0);
        t.user = o.value("user", "");
        t.priority = o.value("priority", 0);
        t.limit = resources(o["limit"]);
        t.reservation = resources(o["reservation"]);
        for (const auto& c : o.value("constraints", json::array()))
            t.constraints.push_back({c.value("key", ""), c.value("value", ""), c.value("hard", true)});
        t.distinct_machines = o.value("distinct", false);
        t.package = o.value("package", "");
        t.avoid = o.value("avoid", std::vector<MachineId>{});
        cell.add_task(t);
        MachineId on = o.value("machine", MachineId{-1});
        if (on >= 0 && on < static_cast<MachineId>(cell.machines().size())) cell.place(id, on);
    }
    // Last: the machines' states and versions exactly as the Borgmaster has them, so that the
    // versions this pass reports match the Borgmaster's if nothing changed meanwhile.
    for (const auto& [id, m] : machines) {
        Machine& mach = cell.machine(static_cast<MachineId>(id));
        mach.up = m.value("up", true);
        mach.draining = m.value("draining", false);
        mach.version = m.value("version", uint64_t{0});
    }
    return cell;
}

}  // namespace

int main(int argc, char** argv) {
    ::signal(SIGPIPE, SIG_IGN);
    std::vector<std::string> masters;
    double interval = 0.5;
    for (int i = 1; i + 1 < argc; i += 2) {
        std::string a = argv[i], v = argv[i + 1];
        if (a == "--master") {
            std::stringstream list(v);
            for (std::string m; std::getline(list, m, ',');)
                if (!m.empty()) masters.push_back(m);
        } else if (a == "--interval") {
            interval = std::stod(v);
        }
    }
    if (masters.empty()) masters.push_back("http://localhost:8080");

    Scheduler sched;
    std::string config_dump;
    std::map<int64_t, json> machines, tasks;
    uint64_t version = 0;
    size_t current = 0;  // which Borgmaster replica we talk to
    bool connected = false;
    std::cout << "borgscheduler: scheduling for " << masters[0] << (masters.size() > 1 ? " (and its replicas)" : "")
              << std::endl;

    while (true) {
        std::this_thread::sleep_for(std::chrono::duration<double>(interval));
        httplib::Client cli(masters[current]);
        cli.set_connection_timeout(1, 0);
        cli.set_read_timeout(3, 0);
        auto r = cli.Get("/internal/sched/state?since=" + std::to_string(version));
        json s = (r && r->status == 200) ? json::parse(r->body, nullptr, false) : json();
        if (!s.is_object()) {  // down, or a replica that is not the elected master: try the next one
            if (connected) std::cout << "borgscheduler: lost " << masters[current] << std::endl;
            connected = false;
            version = 0;
            current = (current + 1) % masters.size();
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            continue;
        }
        if (!connected) std::cout << "borgscheduler: connected to " << masters[current] << std::endl;
        connected = true;

        // 1. Retrieve state changes and update the local copy.
        if (s.value("full", false)) {
            machines.clear();
            tasks.clear();
        }
        const json put = s.value("put", json::object());
        for (auto& [key, value] : put.items()) {
            int64_t id = std::stoll(key.substr(2));
            (key[0] == 'm' ? machines : tasks)[id] = value;
        }
        for (const auto& key : s.value("del", json::array())) {
            std::string k = key.get<std::string>();
            (k[0] == 'm' ? machines : tasks).erase(std::stoll(k.substr(2)));
        }
        version = s.value("version", uint64_t{0});
        if (s.contains("config") && s["config"].dump() != config_dump) {
            const json& c = s["config"];
            config_dump = c.dump();
            SchedulerConfig cfg = sched.config();
            Policy p;
            if (parse_policy(c.value("policy", "hybrid"), &p)) cfg.policy = p;
            cfg.prod_min_priority = c.value("prod_min_priority", cfg.prod_min_priority);
            cfg.reclamation = c.value("reclamation", false);
            cfg.w_spread = c.value("w_spread", cfg.w_spread);
            cfg.w_package = c.value("w_package", cfg.w_package);
            cfg.w_mix = c.value("w_mix", cfg.w_mix);
            sched.set_config(cfg);
        }
        if (s.value("pending", 0) == 0) continue;

        // 2. One scheduling pass on the local copy.
        Cell cell = build_cell(machines, tasks);
        ScheduleResult res = sched.schedule(cell);
        if (res.placed.empty() && res.preempted.empty()) continue;

        // 3. Tell the Borgmaster, which accepts each assignment only if the machine is still as
        //    this pass saw it.
        json placed = json::array(), preempted = json::array();
        for (const auto& p : res.placed)
            placed.push_back({{"task", p.task}, {"machine", p.machine}, {"machine_version", p.machine_version}});
        for (const auto& p : res.preempted) preempted.push_back({{"victim", p.victim}, {"machine", p.machine}, {"by", p.by}});
        json body = {{"version", version},
                     {"placed", placed},
                     {"preempted", preempted},
                     {"stats",
                      {{"unplaced", res.unplaced},
                       {"feasibility_checks", res.feasibility_checks},
                       {"score_computations", res.score_computations},
                       {"cache_hits", res.cache_hits},
                       {"elapsed_ms", res.elapsed_ms}}}};
        auto a = cli.Post("/internal/sched/assign", body.dump(), "application/json");
        json reply = (a && a->status == 200) ? json::parse(a->body, nullptr, false) : json();
        if (reply.is_object())
            std::cout << "borgscheduler: pass placed " << res.placed.size() << ", preempted " << res.preempted.size()
                      << " -> accepted " << reply.value("accepted", 0) << ", rejected " << reply.value("rejected", 0)
                      << std::endl;
    }
}
