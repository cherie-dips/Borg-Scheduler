// borgmaster: the live cell's central controller (§3.1).
//
//  - accepts, edits, reschedules and kills jobs over a REST API (used by the web page and the tests)
//  - runs the Borg scheduler from core/ every second on the pending queue
//  - starts/kills tasks on Borglets and polls every Borglet for state and usage (§3.3)
//  - marks a machine down after missed polls and reschedules its tasks; kills stray tasks
//    on machines that come back
//  - serves the web page (ui/)
//  - with --state <dir>, keeps its state as a snapshot plus a change log (store.h) and picks
//    up where it left off after a restart, without disturbing the running tasks
//  - with --replica <name> as well, it is one of several replicas that share that state: one
//    is the elected master, the others follow it, forward requests to it and take over if it
//    dies. Every replica runs a link shard that polls some of the Borglets (§3.3)
//  - leaves scheduling to a separate borgscheduler process when one is running (§3.4)
//
// REST API
//   GET    /api/state                  machines, jobs (status, timestamps), tasks
//   GET    /api/events?since=N         event log
//   POST   /api/jobs                   submit {name, user, type, priority, tasks, cpu, ram_mb, workload,
//                                      constraints, distinct, delay | start_at, disk_mb, ports, after,
//                                      overrides, appclass, slack_cpu, health, alloc_set}.
//                                      type "alloc" submits an alloc set (§2.4): `tasks` allocs of
//                                      cpu/ram_mb each; other jobs run inside it with alloc_set: <name>
//   PATCH  /api/jobs/<id>              edit fields of a job; restarts tasks only when needed (§2.3)
//   POST   /api/jobs/<id>/reschedule   {delay | start_at}: move a waiting job's start, restart a
//                                      live job, or run a finished job again
//   DELETE /api/jobs/<id>[?purge=1]    kill a live job (kept in history) or remove a finished one;
//                                      purge kills and removes in one go
//   POST   /api/config                 {policy} and/or {reclamation, reclaim_warmup} (§5.5)
//   POST   /api/machines/<id>/fail     {seconds}: simulate a machine failure
//   POST   /api/register               Borglet registration
//   POST   /api/jobs/<id>/update       {action: undo | commit} for a rolling update (§2.3)
//   POST   /api/jobs/<id>/poke         {action: sick | hang | ok | load | mem}: reach into server tasks
//   GET    /api/bns[?job=<name>]       the name service: where each task is, and its health (§2.6)
//   POST   /api/tasks/<id>/exec        {cmd}: run a command inside a running task's jail (§6.1)
//   GET    /api/quota, POST /api/quota {user, band, cpu, ram_mb, disk_mb | remove} (§2.5)
//   POST   /api/machines/<id>/drain    {max_down}: maintenance; /undrain puts it back in service (§4)
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "borg/scheduler.h"
#include "httplib.h"
#include "json.hpp"
#include "store.h"

using json = nlohmann::json;
using namespace borg;

namespace {

constexpr int kProdMin = 200;    // priority bands: free <100, batch 100-199, production 200-299, monitoring 300+
constexpr int kMissesForDown = 3;
constexpr double kLostAfter = 6;  // seconds a started task may be missing from its Borglet's report
constexpr double kMaxDelay = 7 * 24 * 3600;
constexpr double kSchedulerGrace = 5;  // seconds without contact before the Borgmaster schedules itself
constexpr double kNever = 1e18;     // "release time" of a task that waits for another job to finish (§2.3)
constexpr double kLostRate = 2.0;   // tasks per second re-queued off machines that went down (§4)
constexpr double kDrainRate = 1.0;  // tasks per second moved off machines under maintenance (§4)
const char* const kCell = "cc";     // the cell's name, as in the paper's 50.jfoo.ubar.cc.borg.google.com

double now_s() {
    return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string band(int prio) {
    if (prio >= 300) return "monitoring";
    if (prio >= 200) return "production";
    if (prio >= 100) return "batch";
    return "free";
}

bool terminal(const std::string& s) { return s == "finished" || s == "failed" || s == "oom" || s == "killed"; }

// States in which a task occupies a machine.
bool placed(const std::string& s) { return s == "starting" || s == "installing" || s == "running"; }

// Seconds of work for workloads that end on their own; 0 means "runs until killed".
double workload_duration(const json& w) {
    if (!w.is_object() || w.value("type", "service") == "service") return 0;
    return std::max(0.0, w.value("duration", 0.0));
}

std::string fmt(double v, int prec = 2) {
    char b[32];
    std::snprintf(b, sizeof b, "%.*f", prec, v);
    return b;
}

// "in 30s", "in 4m", "in 2h": start times relative to now (the browser shows absolute times).
std::string in_words(double seconds) {
    seconds = std::max(0.0, seconds);
    if (seconds < 90) return "in " + fmt(seconds, 0) + "s";
    if (seconds < 90 * 60) return "in " + fmt(seconds / 60, 0) + "m";
    return "in " + fmt(seconds / 3600, 1) + "h";
}

// A change to a running job (§2.3): rolled out a few tasks at a time, and undoable until it is
// committed.
struct Update {
    bool open = false;         // can still be undone
    bool rolling = false;      // tasks are still being moved to the job's current spec
    json before;               // the job's spec before the update
    int before_version = 0;
    int max_unavailable = 1;   // how many of the job's tasks may be down at once
    int max_disruptions = -1;  // stop after this many restarts (-1 = no limit); the rest is skipped
    int disruptions = 0, skipped = 0;
    double started = 0;
    std::string what;          // "update" or "undo"
};

struct JobInfo {
    JobId id = 0;
    // type: service (restarted on failure) | batch (runs to completion) | alloc (an alloc set, §2.4:
    // each of its "tasks" is an alloc, a reserved slice of a machine that the tasks of other jobs run in)
    std::string name, user, type;
    int priority = 0;
    int task_count = 0;
    double cpu = 0;
    int64_t ram_mb = 0;
    json workload;
    std::vector<Constraint> constraints;
    bool distinct = false;
    double submitted = 0;
    double start_at = 0;  // requested start time; 0 = as soon as possible
    int runs = 1;         // how many times the job was started from scratch
    std::vector<TaskId> tasks;

    int64_t disk_mb = 0;        // disk space per task (§2.3)
    int ports = -1;             // TCP ports per task; Borg picks the numbers. -1 = 1 for servers, else 0
    std::string appclass;       // "ls" (latency-sensitive) or "batch" (§6.2); "" = by job type
    bool slack_cpu = false;     // may use idle CPU beyond its limit (§6.2); off = hard CPU cap
    int health = -1;            // health-check its tasks (§2.6); -1 = yes if it is a server with a port
    std::string after;          // name of a job that must finish before this one starts (§2.3)
    std::string alloc_set;      // name of the alloc set its tasks run in (§2.4); "" = on their own
    json overrides = json::object();  // per-task overrides: {"<index>": {cpu, ram_mb, disk_mb, workload}}
    int spec_version = 1;       // the spec its tasks should run; changes with every edit that needs restarts
    int spec_counter = 1;
    Update update;
};

// What one task of a job asks for, after its per-task overrides (§2.3).
struct TaskSpec {
    double cpu;
    int64_t ram_mb, disk_mb;
    int ports;
    json workload;
};

bool is_server(const json& workload) { return workload.value("type", "service") == "service"; }

TaskSpec spec_of(const JobInfo& j, int index) {
    TaskSpec s{j.cpu, j.ram_mb, j.disk_mb, j.ports, j.workload};
    auto it = j.overrides.find(std::to_string(index));
    if (it != j.overrides.end() && it->is_object()) {
        const json& o = *it;
        if (o.contains("cpu")) s.cpu = o["cpu"].get<double>();
        if (o.contains("ram_mb")) s.ram_mb = o["ram_mb"].get<int64_t>();
        if (o.contains("disk_mb")) s.disk_mb = o["disk_mb"].get<int64_t>();
        if (o.contains("ports")) s.ports = o["ports"].get<int>();
        if (o.contains("workload") && o["workload"].is_object()) s.workload.update(o["workload"]);
    }
    if (s.ports < 0) s.ports = is_server(s.workload) ? 1 : 0;
    return s;
}

std::string appclass_of(const JobInfo& j) { return !j.appclass.empty() ? j.appclass : (j.type == "service" ? "ls" : "batch"); }

bool health_checked(const JobInfo& j, const TaskSpec& s) {
    return j.health >= 0 ? j.health == 1 && s.ports > 0 : is_server(s.workload) && s.ports > 0;
}

struct TaskInfo {
    TaskId id = 0;
    JobId job = 0;
    int index = 0;
    // waiting (delayed start), pending, starting, installing, running, finished, failed, oom, killed
    std::string state = "pending";
    std::string reason;
    MachineId machine = -1;  // current (or last, for finished tasks) machine
    int64_t attempt = 0;
    int restarts = 0, preemptions = 0;
    double since = 0;    // last state change
    double started = 0;  // when the current attempt started running (0 = not running)
    double ended = 0;    // when the task reached a terminal state
    double cpu_usage = 0, mem_mb = 0, disk_used_mb = 0;
    std::vector<int> ports;        // the TCP ports Borg gave it on its machine (§2.3)
    int healthy = -1;              // health check: -1 unknown, 0 failing, 1 healthy (§2.6)
    std::string note;              // one line of status from the task itself
    int spec_version = 1;          // the job spec this task was last started with
    std::vector<MachineId> avoid;  // machines it crashed on (§4)
    bool capped = false;           // held to its CPU limit by the Borglet right now (§6.2)
    bool jailed = false;           // runs in a chroot jail (§6.1)
    TaskId alloc = 0;              // the alloc it runs in (§2.4)
    int64_t alloc_attempt = 0;     // ...and that alloc's attempt, to notice when the alloc moves
};

struct MachineInfo {
    std::string address;
    std::string ip;             // where tasks on this machine can be reached
    std::string status = "up";  // up | down
    int misses = 0;
    double last_seen = 0;
    double cpu_usage = 0, mem_mb = 0;
    bool cgroups = false;
    int port_lo = 0, port_hi = -1;  // ports Borg may hand out on this machine
    std::string drain;              // "" | draining | drained (§4)
    int drain_max_down = 1;         // tasks of one job that may be down at once while draining
    bool cpu_contended = false;
};

// Resource reclamation (§5.5): the Borgmaster estimates what each task really uses (its
// reservation) and lets non-prod work run in the rest of what the task asked for.
struct Reclaim {
    bool enabled = false;
    double warmup = 20;   // seconds after a task starts before its reservation may shrink (300 in the paper)
    double margin = 0.25; // safety margin kept above the measured usage
    double decay = 0.2;   // share of the gap closed per report: the reservation shrinks slowly, grows at once
};

// Resource quota of one user in one priority band (§2.5); a negative amount means unlimited.
struct Quota {
    double cpu = -1, ram_mb = -1, disk_mb = -1;
};

struct Event {
    uint64_t seq;
    double time;
    std::string kind, msg;
};

// An RPC to a Borglet, executed outside the state lock.
struct Action {
    enum Kind { Start, Kill } kind;
    MachineId machine;
    std::string address;
    TaskId task;
    int64_t attempt = 0;
    json body;
};

// A task kept out of the cell until `release`: a delayed start or a crash-restart backoff.
struct Held {
    double release;
    Task task;
};

// Applies the job fields present in `b` to `j` and validates the result.
bool apply_spec(const json& b, JobInfo& j, std::string* err) {
    try {
        if (b.contains("user")) j.user = b["user"].get<std::string>();
        if (b.contains("type")) j.type = b["type"].get<std::string>();
        if (b.contains("priority")) j.priority = b["priority"].get<int>();
        if (b.contains("tasks")) j.task_count = b["tasks"].get<int>();
        if (b.contains("cpu")) j.cpu = b["cpu"].get<double>();
        if (b.contains("ram_mb")) j.ram_mb = b["ram_mb"].get<int64_t>();
        if (b.contains("workload")) j.workload = b["workload"];
        if (b.contains("distinct")) j.distinct = b["distinct"].get<bool>();
        if (b.contains("disk_mb")) j.disk_mb = b["disk_mb"].get<int64_t>();
        if (b.contains("ports")) j.ports = b["ports"].is_null() ? -1 : b["ports"].get<int>();
        if (b.contains("appclass")) j.appclass = b["appclass"].is_null() ? "" : b["appclass"].get<std::string>();
        if (b.contains("slack_cpu")) j.slack_cpu = b["slack_cpu"].get<bool>();
        if (b.contains("health")) j.health = b["health"].is_null() ? -1 : (b["health"].get<bool>() ? 1 : 0);
        if (b.contains("overrides")) j.overrides = b["overrides"].is_null() ? json::object() : b["overrides"];
        if (b.contains("alloc_set")) j.alloc_set = b["alloc_set"].is_null() ? "" : b["alloc_set"].get<std::string>();
        if (j.type == "alloc") {  // an alloc runs no program of its own
            j.workload = json{{"type", "alloc"}};
            j.ports = 0;
            j.health = 0;
            j.alloc_set.clear();
        }
        if (b.contains("constraints")) {
            j.constraints.clear();
            for (const auto& c : b["constraints"])
                if (c.is_object() && !c.value("key", "").empty())
                    j.constraints.push_back({c.value("key", ""), c.value("value", ""), c.value("hard", true)});
        }
        if (j.user.empty()) j.user = "user";
        if (!j.workload.is_object()) j.workload = json::object();
        static const std::set<std::string> kWorkloads = {"service", "sleep", "cpu",    "mem",     "crash",
                                                         "disk",    "client", "alloc", "logsaver"};
        std::string wt = j.workload.value("type", "");
        bool endless = wt == "service" || wt == "client" || wt == "alloc" || wt == "logsaver" ||
                       (wt == "crash" && j.workload.contains("only_on"));
        if (j.type != "service" && j.type != "batch" && j.type != "alloc") *err = "type must be service, batch or alloc";
        else if ((wt == "alloc") != (j.type == "alloc")) *err = "workload.type alloc is only for jobs of type alloc";
        else if (j.priority < 0 || j.priority > 999) *err = "priority must be 0..999";
        else if (j.task_count < 1 || j.task_count > 200) *err = "tasks must be 1..200";
        else if (!(j.cpu > 0) || j.cpu > 64) *err = "cpu must be more than 0 cores";
        else if (j.ram_mb < 1 || j.ram_mb > (1 << 20)) *err = "ram_mb must be at least 1";
        else if (j.disk_mb < 0 || j.disk_mb > (1 << 20)) *err = "disk_mb must be 0 or more";
        else if (j.ports < -1 || j.ports > 8) *err = "ports must be 0..8";
        else if (!j.appclass.empty() && j.appclass != "ls" && j.appclass != "batch") *err = "appclass must be ls or batch";
        else if (!kWorkloads.count(wt))
            *err = "workload.type must be service, client, logsaver, sleep, cpu, mem, disk or crash";
        else if (!endless && !(j.workload.value("duration", 0.0) > 0))
            *err = "workload.duration must be more than 0 seconds";
        else if (wt == "client" && j.workload.value("target", "").empty())
            *err = "workload.target must name the job to call";
        else if (wt == "cpu" && (j.workload.value("threads", 1) < 1 || j.workload.value("threads", 1) > 16))
            *err = "workload.threads must be 1..16";
        else if ((wt == "mem" || wt == "disk") && j.workload.value("mb", 100) < 1) *err = "workload.mb must be at least 1";
        else if (!j.overrides.is_object()) *err = "overrides must be an object keyed by task index";
        else {
            for (auto& [key, o] : j.overrides.items()) {
                bool index_ok = !key.empty() && key.size() <= 3 && key.find_first_not_of("0123456789") == std::string::npos;
                if (!index_ok || !o.is_object()) *err = "overrides must look like {\"0\": {\"cpu\": 0.5}}";
                else if (o.contains("cpu") && !(o["cpu"].get<double>() > 0)) *err = "an override's cpu must be more than 0";
                else if (o.contains("ram_mb") && o["ram_mb"].get<int64_t>() < 1) *err = "an override's ram_mb must be at least 1";
                else if (o.contains("disk_mb") && o["disk_mb"].get<int64_t>() < 0) *err = "an override's disk_mb must be 0 or more";
                else if (o.contains("workload") && !o["workload"].is_object()) *err = "an override's workload must be an object";
                if (!err->empty()) break;
            }
        }
    } catch (const json::exception&) {
        *err = "a field has the wrong type";
    }
    return err->empty();
}

bool valid_name(const std::string& n) {
    static const std::regex re("[A-Za-z0-9][A-Za-z0-9._-]{0,39}");
    return std::regex_match(n, re);
}

// Requested start time from {delay} or {start_at}; 0 = now. Sets *err on nonsense.
double requested_start(const json& b, std::string* err) {
    double now = now_s();
    try {
        if (b.contains("start_at") && !b["start_at"].is_null()) {
            double t = b["start_at"].get<double>();
            if (t > now + kMaxDelay) *err = "start time must be within 7 days";
            return t > now ? t : 0;
        }
        if (b.contains("delay") && !b["delay"].is_null()) {
            double d = b["delay"].get<double>();
            if (d < 0 || d > kMaxDelay) *err = "delay must be between 0 and 7 days";
            return d > 0 ? now + d : 0;
        }
    } catch (const json::exception&) {
        *err = "start_at/delay must be numbers (seconds)";
    }
    return 0;
}

class Master {
public:
    Master(Policy policy, const std::string& state_dir, const std::string& replica, const std::string& advertise)
        : store_(state_dir), replica_(replica), advertise_(advertise) {
        SchedulerConfig c;
        c.policy = policy;
        c.prod_min_priority = kProdMin;
        c.w_spread = 0.5;   // live cell: prefer spreading a job's tasks across machines
        c.w_package = 1.0;  // and machines that already have its package
        c.w_mix = 0.2;      // and a mix of prod and non-prod work on each machine (§3.2)
        sched_.set_config(c);
        if (!replica_.empty()) {
            leader_ = false;  // one of several replicas: wait to be elected (replica_loop)
        } else if (store_.enabled()) {
            std::map<std::string, json> stored = store_.load();
            if (!stored.empty()) {
                restore(stored);
                restored_at_ = now_s();
                event("master", "Borgmaster restarted: state restored from its checkpoint (" + std::to_string(jobs_.size()) +
                                    " job(s), " + std::to_string(tinfo_.size()) + " task(s), " +
                                    std::to_string(minfo_.size()) + " machine(s)); running tasks were not disturbed");
                store_.snapshot(objects());  // a clean log: the last line may have been cut off
            }
        }
    }

    void serve(int port, const std::string& ui_dir) {
        std::thread([this] { scheduler_loop(); }).detach();
        std::thread([this] { link_loop(); }).detach();
        if (!replica_.empty()) std::thread([this] { replica_loop(); }).detach();

        httplib::Server svr;
        // Browsers keep idle connections open, and each one holds a worker thread: enough threads
        // and a short keep-alive, so a few open tabs can never starve the API.
        svr.new_task_queue = [] { return new httplib::ThreadPool(48); };
        svr.set_keep_alive_timeout(2);
        if (!svr.set_mount_point("/", ui_dir)) std::cerr << "warning: UI dir " << ui_dir << " not found\n";
        // Every API route goes through this: a replica that is not the elected master passes the
        // request on to the one that is, and relays the answer.
        auto api = [this](httplib::Server::Handler handler) {
            return [this, handler](const httplib::Request& req, httplib::Response& res) {
                if (!leader_ && req.path != "/internal/replica") forward(req, res);
                else handler(req, res);
            };
        };

        auto reply = [](httplib::Response& res, const json& j, int status = 200) {
            res.status = status;
            res.set_content(j.dump(), "application/json");
        };
        auto body_of = [](const httplib::Request& req) {
            auto b = json::parse(req.body.empty() ? "{}" : req.body, nullptr, false);
            return b.is_object() ? b : json();
        };

        svr.Get("/api/state", api([&](const httplib::Request&, httplib::Response& res) { reply(res, state_json()); }));
        svr.Get("/api/events", api([&](const httplib::Request& req, httplib::Response& res) {
            uint64_t since = 0;
            try {
                if (req.has_param("since")) since = std::stoull(req.get_param_value("since"));
            } catch (const std::exception&) {
            }
            reply(res, events_json(since));
        }));
        svr.Post("/api/jobs", api([&](const httplib::Request& req, httplib::Response& res) {
            std::string err;
            json b = body_of(req);
            JobId id = b.is_object() ? submit(b, &err) : (err = "invalid JSON", 0);
            if (id) reply(res, {{"id", id}});
            else reply(res, {{"error", err}}, err.rfind("rejected by admission control", 0) == 0 ? 403 : 400);
        }));
        svr.Patch(R"(/api/jobs/(\d+))", api([&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json b = body_of(req);
            json out = b.is_object() ? edit_job(std::stoll(req.matches[1].str()), b, &status)
                                     : (status = 400, json{{"error", "invalid JSON"}});
            reply(res, out, status);
        }));
        svr.Post(R"(/api/jobs/(\d+)/reschedule)", api([&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json b = body_of(req);
            json out = b.is_object() ? reschedule_job(std::stoll(req.matches[1].str()), b, &status)
                                     : (status = 400, json{{"error", "invalid JSON"}});
            reply(res, out, status);
        }));
        // {action: undo | commit} for the job's open update (§2.3)
        svr.Post(R"(/api/jobs/(\d+)/update)", api([&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json b = body_of(req);
            json out = b.is_object() ? update_job(std::stoll(req.matches[1].str()), b, &status)
                                     : (status = 400, json{{"error", "invalid JSON"}});
            reply(res, out, status);
        }));
        svr.Post(R"(/api/jobs/(\d+)/poke)", api([&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json b = body_of(req);
            json out = b.is_object() ? poke_job(std::stoll(req.matches[1].str()), b, &status)
                                     : (status = 400, json{{"error", "invalid JSON"}});
            reply(res, out, status);
        }));
        // {cmd}: run a shell command inside a running task's jail (§6.1)
        svr.Post(R"(/api/tasks/(\d+)/exec)", api([&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json b = body_of(req);
            json out = b.is_object() ? exec_task(std::stoll(req.matches[1].str()), b, &status)
                                     : (status = 400, json{{"error", "invalid JSON"}});
            reply(res, out, status);
        }));
        svr.Get("/api/bns", api([&](const httplib::Request& req, httplib::Response& res) {
            reply(res, bns_json(req.has_param("job") ? req.get_param_value("job") : ""));
        }));
        svr.Get("/api/quota", api([&](const httplib::Request&, httplib::Response& res) { reply(res, quota_json()); }));
        svr.Post("/api/quota", api([&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json b = body_of(req);
            json out = b.is_object() ? set_quota(b, &status) : (status = 400, json{{"error", "invalid JSON"}});
            reply(res, out, status);
        }));
        svr.Post(R"(/api/machines/(\d+)/(drain|undrain))", api([&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json out = drain_machine(std::stoi(req.matches[1].str()), body_of(req), req.matches[2].str() == "drain", &status);
            reply(res, out, status);
        }));
        svr.Delete(R"(/api/jobs/(\d+))", api([&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            bool purge = req.has_param("purge") && req.get_param_value("purge") != "0";
            json out = delete_job(std::stoll(req.matches[1].str()), purge, &status);
            reply(res, out, status);
        }));
        svr.Post("/api/config", api([&](const httplib::Request& req, httplib::Response& res) {
            json b = body_of(req);
            Policy p = Policy::Hybrid;
            bool has_policy = b.is_object() && b.contains("policy");
            bool has_reclaim = b.is_object() && (b.contains("reclamation") || b.contains("reclaim_warmup"));
            if ((!has_policy && !has_reclaim) ||
                (has_policy && (!b["policy"].is_string() || !parse_policy(b["policy"].get<std::string>(), &p)))) {
                reply(res, {{"error", "send policy (worst_fit, best_fit or hybrid), reclamation (true/false) or reclaim_warmup (seconds)"}}, 400);
                return;
            }
            std::lock_guard<std::mutex> g(mu_);
            SchedulerConfig c = sched_.config();
            if (has_policy) {
                c.policy = p;
                event("config", std::string("scoring policy set to ") + policy_name(p));
            }
            if (has_reclaim) {
                if (b.contains("reclamation") && b["reclamation"].is_boolean()) reclaim_.enabled = b["reclamation"].get<bool>();
                if (b.contains("reclaim_warmup") && b["reclaim_warmup"].is_number())
                    reclaim_.warmup = std::min(3600.0, std::max(0.0, b["reclaim_warmup"].get<double>()));
                c.reclamation = reclaim_.enabled;
                event("config", std::string("resource reclamation ") + (reclaim_.enabled ? "on" : "off") +
                                    (reclaim_.enabled ? ": reservations may shrink " + fmt(reclaim_.warmup, 0) + "s after a task starts" : ""));
                if (!reclaim_.enabled)  // every task gets its full request reserved again
                    for (const auto& [id, t] : cell_.tasks()) reset_reservations_.push_back(id);
                for (TaskId id : reset_reservations_) cell_.set_reservation(id, cell_.task(id).limit);
                reset_reservations_.clear();
            }
            sched_.set_config(c);
            wake_.notify_all();
            reply(res, {{"ok", true}});
        }));
        svr.Post(R"(/api/machines/(\d+)/fail)", api([&](const httplib::Request& req, httplib::Response& res) {
            MachineId m = std::stoi(req.matches[1].str());
            json b = body_of(req);
            double secs = 20;
            if (b.is_object() && b.contains("seconds") && b["seconds"].is_number()) secs = b["seconds"].get<double>();
            secs = std::min(600.0, std::max(3.0, secs));
            std::string addr;
            {
                std::lock_guard<std::mutex> g(mu_);
                if (m < 0 || m >= static_cast<MachineId>(minfo_.size())) {
                    reply(res, {{"error", "no such machine"}}, 404);
                    return;
                }
                addr = minfo_[m].address;
                event("machine", cell_.machine(m).name + ": failure injected for " + fmt(secs, 0) + "s");
            }
            httplib::Client cli(addr);
            cli.set_connection_timeout(1, 0);
            auto r = cli.Post("/admin/fail", json{{"seconds", secs}}.dump(), "application/json");
            if (r && r->status == 200) reply(res, {{"ok", true}, {"seconds", secs}});
            else reply(res, {{"error", "machine did not answer (is it already down?)"}}, 502);
        }));
        // Link shards of the other replicas (§3.3): which Borglets to poll, and what they reported.
        svr.Get("/internal/link/plan", api([&](const httplib::Request& req, httplib::Response& res) {
            std::lock_guard<std::mutex> g(mu_);
            reply(res, link_plan(req.has_param("replica") ? req.get_param_value("replica") : ""));
        }));
        svr.Post("/internal/link/report", api([&](const httplib::Request& req, httplib::Response& res) {
            json b = body_of(req);
            reply(res, b.is_object() ? link_report(b) : json{{"error", "invalid JSON"}}, b.is_object() ? 200 : 400);
        }));
        // Which replica answers here (never forwarded).
        svr.Get("/internal/replica", api([&](const httplib::Request&, httplib::Response& res) {
            std::lock_guard<std::mutex> g(mu_);
            reply(res, {{"name", replica_}, {"elected", leader_.load()}, {"master", leader_name_}, {"master_url", leader_url_}});
        }));
        // The separate scheduler process (§3.4): it fetches state changes, and sends back assignments.
        svr.Get("/internal/sched/state", api([&](const httplib::Request& req, httplib::Response& res) {
            uint64_t since = 0;
            try {
                if (req.has_param("since")) since = std::stoull(req.get_param_value("since"));
            } catch (const std::exception&) {
            }
            reply(res, sched_state(since));
        }));
        svr.Post("/internal/sched/assign", api([&](const httplib::Request& req, httplib::Response& res) {
            json b = body_of(req);
            if (!b.is_object()) {
                reply(res, {{"error", "invalid JSON"}}, 400);
                return;
            }
            reply(res, sched_assign(b));
        }));
        svr.Post("/api/register", api([&](const httplib::Request& req, httplib::Response& res) {
            json b = body_of(req);
            if (!b.is_object() || !b.contains("name") || !b.contains("address")) {
                reply(res, {{"error", "bad registration"}}, 400);
                return;
            }
            register_machine(b, req.has_header("X-Forwarded-For") ? req.get_header_value("X-Forwarded-For") : req.remote_addr);
            reply(res, {{"ok", true}});
        }));

        std::cout << "borgmaster listening on :" << port << " (UI at http://localhost:" << port << ")" << std::endl;
        svr.listen("0.0.0.0", port);
    }

private:
    // ---- state changes (all called with mu_ held) ------------------------------------------

    void event(const std::string& kind, const std::string& msg) {
        events_.push_back({++event_seq_, now_s(), kind, msg});
        if (events_.size() > 1000) events_.pop_front();
        std::cout << "[" << kind << "] " << msg << std::endl;
    }

    std::string task_name(TaskId id) const {
        const TaskInfo& t = tinfo_.at(id);
        return jobs_.at(t.job).name + "/" + std::to_string(t.index);
    }

    std::string machine_name(MachineId m) const { return m >= 0 ? cell_.machine(m).name : "-"; }

    void set_state(TaskInfo& t, const std::string& state, const std::string& reason) {
        t.state = state;
        t.reason = reason;
        t.since = now_s();
        if (state != "running" && state != "installing") t.cpu_usage = t.mem_mb = 0;
        if (!placed(state)) {
            t.ports.clear();
            t.alloc = 0;
            t.healthy = -1;
            t.capped = false;
            t.note.clear();
        }
    }

    Action kill_action(MachineId m, TaskId id) const { return {Action::Kill, m, minfo_[m].address, id, 0, json()}; }

    // Puts a placed task back in the pending queue (machine failure, preemption, restart).
    void requeue(TaskId id, const std::string& reason) {
        TaskInfo& t = tinfo_.at(id);
        const JobInfo& j = jobs_.at(t.job);
        if (cell_.has_task(id)) {
            if (t.spec_version != j.spec_version) {  // the job was edited meanwhile: come back with the new spec
                cell_.remove_task(id);
                cell_.add_task(make_task(j, t.index, id));
                t.spec_version = j.spec_version;
            } else {
                cell_.unplace(id);
                cell_.set_reservation(id, cell_.task(id).limit);
            }
        }
        t.started = 0;
        set_state(t, "pending", reason);
    }

    // Resource reclamation (§5.5): moves a running task's reservation towards what it really
    // uses plus a safety margin. It shrinks slowly, only after the task's start-up, and grows
    // at once when the task uses more.
    void update_reservation(TaskId id, const TaskInfo& t, double now) {
        if (!cell_.has_task(id)) return;
        const Task& ct = cell_.task(id);
        Resources target = ct.limit;
        // An alloc keeps its resources whether or not they are used (§2.4), so it is never reclaimed.
        bool reclaimable = jobs_.at(t.job).type != "alloc";
        if (reclaimable && reclaim_.enabled && t.started > 0 && now - t.started >= reclaim_.warmup) {
            double cpu = std::min(ct.limit.cpu, t.cpu_usage * (1 + reclaim_.margin) + 0.02);
            double ram = std::min(ct.limit.ram, t.mem_mb * (1 + reclaim_.margin) + 4);
            auto step = [&](double current, double want) {
                return want >= current ? want : current - reclaim_.decay * (current - want);
            };
            target.cpu = step(ct.reservation.cpu, cpu);
            target.ram = step(ct.reservation.ram, ram);
        }
        // Small changes are ignored: each one invalidates the machine's cached scores (§3.4).
        bool changed = std::fabs(target.cpu - ct.reservation.cpu) > 0.02 * ct.limit.cpu ||
                       std::fabs(target.ram - ct.reservation.ram) > 0.02 * ct.limit.ram;
        if (changed) {
            cell_.set_reservation(id, target);
            wake_.notify_all();
        }
    }

    void finish(TaskId id, const std::string& state, const std::string& reason) {
        cell_.remove_task(id);
        held_.erase(id);
        TaskInfo& t = tinfo_.at(id);
        t.ended = now_s();
        set_state(t, state, reason);
    }

    Task make_task(const JobInfo& j, int index, TaskId id = -1) const {
        TaskSpec s = spec_of(j, index);
        Task t;
        t.id = id;
        t.job = j.id;
        t.index = index;
        t.user = j.user;
        t.priority = j.priority;
        t.limit = {s.cpu, static_cast<double>(s.ram_mb), static_cast<double>(s.disk_mb), static_cast<double>(s.ports)};
        t.reservation = t.limit;
        t.constraints = j.constraints;
        t.distinct_machines = j.distinct;
        t.package = j.name;
        auto known = tinfo_.find(id);
        if (known != tinfo_.end()) t.avoid = known->second.avoid;
        return t;
    }

    // What the Borglet is told when it starts a task.
    json start_body(const TaskInfo& t, const JobInfo& j) const {
        TaskSpec s = spec_of(j, t.index);
        return {{"id", t.id},           {"attempt", t.attempt},       {"job", j.name},
                {"index", t.index},     {"user", j.user},             {"package", j.name},
                {"cpu", s.cpu},         {"ram_mb", s.ram_mb},         {"disk_mb", s.disk_mb},
                {"ports", t.ports},     {"priority", j.priority},     {"appclass", appclass_of(j)},
                {"slack_cpu", j.slack_cpu}, {"health", health_checked(j, s)}, {"workload", s.workload}};
    }

    // Borg manages the ports of a machine and tells each task which ones to use (§2.3).
    std::vector<int> assign_ports(MachineId m, int count) const {
        std::set<int> used;
        for (const auto& [id, t] : tinfo_)
            if (t.machine == m && placed(t.state)) used.insert(t.ports.begin(), t.ports.end());
        std::vector<int> out;
        for (int p = minfo_[m].port_lo; p <= minfo_[m].port_hi && static_cast<int>(out.size()) < count; ++p)
            if (!used.count(p)) out.push_back(p);
        return out;
    }

    // The task's stable name in the Borg name service (§2.6): <index>.<job>.<user>.<cell>.
    std::string bns_name(const TaskInfo& t, const JobInfo& j) const {
        return std::to_string(t.index) + "." + j.name + "." + j.user + "." + kCell;
    }

    // Tasks of a job that runs inside an alloc set are not placed by the scheduler: the
    // Borgmaster puts each of them into its alloc (place_in_allocs).
    static bool inner(const JobInfo& j) { return !j.alloc_set.empty(); }

    // Puts a task in the pending queue.
    void enqueue(const JobInfo& j, const Task& t) {
        if (!inner(j)) cell_.add_task(t);
    }

    const JobInfo* find_job(const std::string& name) const {
        for (const auto& [id, j] : jobs_)
            if (j.name == name) return &j;
        return nullptr;
    }

    // Creates task `index` of job `j`: pending now, or held until `release` (> now).
    void add_task(JobInfo& j, int index, double release) {
        TaskInfo ti;
        ti.job = j.id;
        ti.index = index;
        ti.since = now_s();
        ti.spec_version = j.spec_version;
        ti.id = cell_.reserve_id();
        if (release > now_s()) {
            held_[ti.id] = {release, make_task(j, index, ti.id)};
            ti.state = "waiting";
            ti.reason = release >= kNever ? "waits for job " + j.after + " to finish" : "scheduled start";
        } else {
            enqueue(j, make_task(j, index, ti.id));
            ti.reason = inner(j) ? "waiting for its alloc" : "waiting for the scheduler";
        }
        tinfo_[ti.id] = ti;
        j.tasks.push_back(ti.id);
    }

    // Stops a live task (if it occupies a machine) and queues it again with the job's current
    // spec: now, at `release`, or (release < 0) whenever it was already held until.
    void restart_task(const JobInfo& j, TaskId id, double release, const std::string& why,
                      std::vector<Action>& actions) {
        TaskInfo& t = tinfo_.at(id);
        auto h = held_.find(id);
        if (release < 0) release = h != held_.end() ? h->second.release : 0;
        if (placed(t.state) && t.machine >= 0) actions.push_back(kill_action(t.machine, id));
        if (h != held_.end()) held_.erase(h);
        cell_.remove_task(id);
        Task fresh = make_task(j, t.index, id);
        t.started = 0;
        t.spec_version = j.spec_version;
        if (release > now_s()) {
            held_[id] = {release, fresh};
            set_state(t, "waiting", why);
        } else {
            enqueue(j, fresh);
            set_state(t, "pending", why);
        }
    }

    // Priority and user changes need no restart (§2.3): rewrite them where the task lives.
    void update_in_place(const JobInfo& j, TaskId id) {
        auto h = held_.find(id);
        if (h != held_.end()) {
            h->second.task.priority = j.priority;
            h->second.task.user = j.user;
            return;
        }
        if (!cell_.has_task(id)) return;
        Task& t = cell_.task(id);
        MachineId m = t.machine;
        if (m >= 0) cell_.unplace(id);  // per-priority totals on the machine are keyed by priority
        t.priority = j.priority;
        t.user = j.user;
        if (m >= 0) cell_.place(id, m);
    }

    // Removes a task completely (scale-down, purge).
    void drop_task(TaskId id, std::vector<Action>& actions) {
        TaskInfo& t = tinfo_.at(id);
        if (placed(t.state) && t.machine >= 0) actions.push_back(kill_action(t.machine, id));
        held_.erase(id);
        cell_.remove_task(id);
        tinfo_.erase(id);
    }

    // running > queued > waiting while any task is live; then failed > killed > completed.
    std::string job_status(const JobInfo& j) const {
        int live = 0, running = 0, waiting = 0, failed = 0, killed = 0;
        for (TaskId id : j.tasks) {
            const std::string& s = tinfo_.at(id).state;
            if (terminal(s)) {
                failed += s == "failed" || s == "oom";
                killed += s == "killed";
                continue;
            }
            live++;
            running += placed(s);
            waiting += s == "waiting";
        }
        if (live == 0) return failed ? "failed" : (killed ? "killed" : "completed");
        if (running) return "running";
        return waiting == live ? "waiting" : "queued";
    }

    static bool done(const std::string& status) {
        return status == "completed" || status == "failed" || status == "killed";
    }

    void register_machine(const json& b, const std::string& ip) {
        std::lock_guard<std::mutex> g(mu_);
        std::string name = b.value("name", "");
        int port_lo = b.value("port_lo", 0), port_hi = b.value("port_hi", -1);
        Resources cap{b.value("cpu", 1.0), b.value("ram", 512.0), b.value("disk", 2048.0),
                      static_cast<double>(std::max(0, port_hi - port_lo + 1))};
        std::map<std::string, std::string> attrs;
        if (b.contains("attributes") && b["attributes"].is_object())
            for (auto& [k, v] : b["attributes"].items()) attrs[k] = v.is_string() ? v.get<std::string>() : v.dump();
        for (auto& m : cell_.machines()) {
            if (m.name != name) continue;
            minfo_[m.id].address = b.value("address", "");
            minfo_[m.id].ip = ip;
            minfo_[m.id].port_lo = port_lo;
            minfo_[m.id].port_hi = port_hi;
            m.capacity = cap;
            m.attributes = attrs;
            m.version++;
            return;  // the poller marks it up again on the next successful poll
        }
        cell_.add_machine(name, cap, attrs);
        MachineInfo mi;
        mi.address = b.value("address", "");
        mi.ip = ip;
        mi.port_lo = port_lo;
        mi.port_hi = port_hi;
        mi.last_seen = now_s();
        minfo_.push_back(mi);
        event("machine", name + " joined the cell (" + fmt(cap.cpu) + " cpu, " + fmt(cap.ram, 0) + " MB)");
        wake_.notify_all();
    }

    JobId submit(const json& b, std::string* err) {
        JobInfo j;
        j.user = "user";
        j.type = "batch";
        j.priority = 100;
        j.task_count = 1;
        j.cpu = 0.1;
        j.ram_mb = 64;
        try {
            j.name = b.value("name", "");
            if (!b.contains("workload"))
                j.workload = b.value("type", "batch") == "service" ? json{{"type", "service"}}
                                                                   : json{{"type", "sleep"}, {"duration", 30}};
        } catch (const json::exception&) {
            *err = "name and type must be strings";
            return 0;
        }
        if (!valid_name(j.name)) {
            *err = "name must be 1-40 letters, digits, '.', '_' or '-' (no spaces)";
            return 0;
        }
        if (!apply_spec(b, j, err)) return 0;
        double start = requested_start(b, err);
        if (!err->empty()) return 0;
        if (b.contains("after") && b["after"].is_string()) j.after = b["after"].get<std::string>();

        std::lock_guard<std::mutex> g(mu_);
        for (const auto& [id, other] : jobs_) {
            if (other.name == j.name) {
                *err = "a job named '" + j.name + "' already exists: pick another name, or edit or reschedule it";
                return 0;
            }
        }
        if (!j.after.empty() && start > 0) {
            *err = "give either after (start when another job has finished) or a start delay, not both";
            return 0;
        }
        if (!j.after.empty()) {  // the start of a job can be deferred until a prior one finishes (§2.3)
            const JobInfo* prior = find_job(j.after);
            if (!prior) {
                *err = "after: there is no job named '" + j.after + "'";
                return 0;
            }
            if (job_status(*prior) == "completed") j.after.clear();
            else start = kNever;
        }
        if (inner(j)) {
            const JobInfo* set = find_job(j.alloc_set);
            if (!set || set->type != "alloc") {
                *err = "alloc_set: there is no alloc set named '" + j.alloc_set + "'";
                return 0;
            }
            for (int i = 0; i < j.task_count; ++i) {
                TaskSpec need = spec_of(j, i), size = spec_of(*set, i % set->task_count);
                if (need.cpu > size.cpu + kEps || need.ram_mb > size.ram_mb || need.disk_mb > size.disk_mb) {
                    *err = "a task of " + j.name + " asks for more than one alloc of " + set->name + " holds (" +
                           fmt(size.cpu) + " cpu, " + std::to_string(size.ram_mb) + " MB)";
                    return 0;
                }
            }
        }
        if (!admit(j, 0, err)) {
            event("admission", *err);
            return 0;
        }
        j.id = next_job_++;
        j.submitted = now_s();
        j.start_at = start >= kNever ? 0 : start;
        for (int i = 0; i < j.task_count; ++i) add_task(j, i, start);
        event("job", "submitted " + j.name + " (" + std::to_string(j.task_count) + " x " + fmt(j.cpu) + " cpu / " +
                         std::to_string(j.ram_mb) + " MB, priority " + std::to_string(j.priority) + " " +
                         band(j.priority) + ", " + j.type + ")" +
                         (start >= kNever ? ", starts after " + j.after
                                          : start > 0 ? ", starts " + in_words(start - now_s()) : ""));
        JobId id = j.id;
        jobs_[id] = std::move(j);
        wake_.notify_all();
        return id;
    }

    // ---- quota and admission control (§2.5) ------------------------------------------------

    // What all tasks of a job ask for together.
    static Resources requested(const JobInfo& j) {
        Resources r;
        for (int i = 0; i < j.task_count; ++i) {
            TaskSpec s = spec_of(j, i);
            r += Resources{s.cpu, static_cast<double>(s.ram_mb), static_cast<double>(s.disk_mb)};
        }
        return r;
    }

    // What a user's live jobs ask for in one priority band, not counting job `except`.
    Resources quota_used(const std::string& user, const std::string& b, JobId except) const {
        Resources r;
        for (const auto& [id, j] : jobs_) {
            if (id == except || j.user != user || band(j.priority) != b || inner(j) || done(job_status(j))) continue;
            r += requested(j);
        }
        return r;
    }

    // The quota that applies to a user in a band: their own, else the default ("*"), else none.
    const Quota* quota_for(const std::string& user, const std::string& b) const {
        for (const std::string& who : {user, std::string("*")}) {
            auto u = quota_.find(who);
            if (u == quota_.end()) continue;
            auto q = u->second.find(b);
            if (q != u->second.end()) return &q->second;
        }
        return nullptr;
    }

    // Admission control: a job that does not fit its user's quota at its priority is rejected
    // at once, instead of waiting in the queue. Quota-checking is not part of scheduling.
    bool admit(const JobInfo& j, JobId except, std::string* err) const {
        std::string b = band(j.priority);
        if (b == "free") return true;  // everyone has unlimited quota at the lowest priorities
        if (inner(j)) return true;     // it runs in an alloc set, whose resources were admitted already
        const Quota* q = quota_for(j.user, b);
        if (!q) return true;
        Resources need = requested(j), used = quota_used(j.user, b, except);
        auto check = [&](double need, double used, double limit, const char* unit, int prec) {
            if (limit < 0 || used + need <= limit + kEps) return true;
            *err = "rejected by admission control: " + j.name + " asks for " + fmt(need, prec) + " " + unit + " at " +
                   b + " priority, but " + j.user + " has " + fmt(std::max(0.0, limit - used), prec) + " of " +
                   fmt(limit, prec) + " " + unit + " left";
            return false;
        };
        return check(need.cpu, used.cpu, q->cpu, "cpu", 2) && check(need.ram, used.ram, q->ram_mb, "MB of RAM", 0) &&
               check(need.disk, used.disk, q->disk_mb, "MB of disk", 0);
    }

    json set_quota(const json& b, int* status) {
        std::lock_guard<std::mutex> g(mu_);
        auto bad = [&](const std::string& msg) {
            *status = 400;
            return json{{"error", msg}};
        };
        std::string user, bnd;
        Quota q;
        bool remove = false;
        try {
            user = b.value("user", "");
            bnd = b.value("band", "");
            remove = b.value("remove", false);
            auto amount = [&](const char* key) {
                return b.contains(key) && b[key].is_number() ? b[key].get<double>() : -1.0;
            };
            q.cpu = amount("cpu");
            q.ram_mb = amount("ram_mb");
            q.disk_mb = amount("disk_mb");
        } catch (const json::exception&) {
            return bad("user and band must be strings; cpu, ram_mb and disk_mb numbers");
        }
        if (user.empty()) return bad("user is required (use * for everyone without their own quota)");
        if (bnd != "monitoring" && bnd != "production" && bnd != "batch")
            return bad("band must be monitoring, production or batch (quota in the free band is always unlimited)");
        if (remove || (q.cpu < 0 && q.ram_mb < 0 && q.disk_mb < 0)) {
            if (quota_.count(user)) quota_[user].erase(bnd);
            if (quota_.count(user) && quota_[user].empty()) quota_.erase(user);
            event("quota", user + " now has unlimited quota in the " + bnd + " band");
            return {{"ok", true}};
        }
        // Quota at production priority is limited to what the cell really has, so that a prod
        // job that fits its quota can expect to run. Lower bands may be oversold.
        if (bnd != "batch" && user != "*") {
            Resources cap, sold;
            for (const auto& m : cell_.machines()) cap += m.capacity;
            for (const auto& [u, bands] : quota_)
                for (const auto& [bb, other] : bands)
                    if (bb != "batch" && u != "*" && !(u == user && bb == bnd))
                        sold += Resources{std::max(0.0, other.cpu), std::max(0.0, other.ram_mb)};
            if (q.cpu >= 0 && sold.cpu + q.cpu > cap.cpu + kEps)
                return bad("prod quota cannot be oversold: the cell has " + fmt(cap.cpu) + " cpu and " +
                           fmt(sold.cpu) + " is already promised");
            if (q.ram_mb >= 0 && sold.ram + q.ram_mb > cap.ram + kEps)
                return bad("prod quota cannot be oversold: the cell has " + fmt(cap.ram, 0) + " MB of RAM and " +
                           fmt(sold.ram, 0) + " MB is already promised");
        }
        quota_[user][bnd] = q;
        auto show = [](double v, int prec) { return v < 0 ? std::string("unlimited") : fmt(v, prec); };
        event("quota", "quota of " + user + " in the " + bnd + " band: " + show(q.cpu, 2) + " cpu, " +
                           show(q.ram_mb, 0) + " MB RAM, " + show(q.disk_mb, 0) + " MB disk");
        return {{"ok", true}};
    }

    json quota_json() {
        std::lock_guard<std::mutex> g(mu_);
        auto amount = [](double v) { return v < 0 ? json() : json(v); };
        json rows = json::array();
        for (const auto& [user, bands] : quota_) {
            for (const auto& [bnd, q] : bands) {
                Resources used = user == "*" ? Resources{} : quota_used(user, bnd, 0);
                rows.push_back({{"user", user},
                                {"band", bnd},
                                {"cpu", amount(q.cpu)},
                                {"ram_mb", amount(q.ram_mb)},
                                {"disk_mb", amount(q.disk_mb)},
                                {"used", {{"cpu", used.cpu}, {"ram_mb", used.ram}, {"disk_mb", used.disk}}}});
            }
        }
        Resources cap;
        for (const auto& m : cell_.machines()) cap += m.capacity;
        return {{"quotas", rows}, {"capacity", {{"cpu", cap.cpu}, {"ram_mb", cap.ram}, {"disk_mb", cap.disk}}}};
    }

    // ---- editing a job: in place, by a rolling update, or undone (§2.3) -----------------------

    // The editable fields of a job, in the form apply_spec() takes; kept to undo an update.
    static json spec_json(const JobInfo& j) {
        json cons = json::array();
        for (const auto& c : j.constraints) cons.push_back({{"key", c.key}, {"value", c.value}, {"hard", c.hard}});
        return {{"user", j.user},
                {"type", j.type},
                {"priority", j.priority},
                {"tasks", j.task_count},
                {"cpu", j.cpu},
                {"ram_mb", j.ram_mb},
                {"disk_mb", j.disk_mb},
                {"ports", j.ports < 0 ? json() : json(j.ports)},
                {"appclass", j.appclass.empty() ? json() : json(j.appclass)},
                {"slack_cpu", j.slack_cpu},
                {"health", j.health < 0 ? json() : json(j.health == 1)},
                {"workload", j.workload},
                {"constraints", cons},
                {"distinct", j.distinct},
                {"overrides", j.overrides}};
    }

    json edit_job(JobId id, const json& b, int* status) {
        std::vector<Action> actions;
        json out;
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = jobs_.find(id);
            if (it == jobs_.end()) {
                *status = 404;
                return {{"error", "no such job"}};
            }
            JobInfo& j = it->second;
            if (b.contains("name") && b["name"] != j.name) {
                *status = 400;
                return {{"error", "a job cannot be renamed; submit a new one instead"}};
            }
            JobInfo nj = j;
            std::string err;
            if (!apply_spec(b, nj, &err)) {
                *status = 400;
                return {{"error", err}};
            }
            if (!done(job_status(j)) && !admit(nj, id, &err)) {
                *status = 403;
                event("admission", err);
                return {{"error", err}};
            }
            int max_unavailable = 1, max_disruptions = -1;
            if (b.contains("rolling") && b["rolling"].is_object()) {
                max_unavailable = std::max(1, b["rolling"].value("max_unavailable", 1));
                max_disruptions = b["rolling"].value("max_disruptions", -1);
            } else if (b.contains("rolling") && b["rolling"] == false) {
                max_unavailable = 1 << 20;  // all at once
            }
            out = apply_edit(j, nj, max_unavailable, max_disruptions, false, actions);
            wake_.notify_all();
        }
        run_actions(actions);
        return out;
    }

    // Applies a validated new spec `nj` to job `j`. Priority and user change in place; a new
    // task count adds or removes tasks; anything else needs restarts and becomes a rolling
    // update (or, with `undo`, a roll-back to the spec before the last update).
    json apply_edit(JobInfo& j, JobInfo nj, int max_unavailable, int max_disruptions, bool undo,
                    std::vector<Action>& actions) {
        auto same_constraints = [](const std::vector<Constraint>& a, const std::vector<Constraint>& c) {
            if (a.size() != c.size()) return false;
            for (size_t i = 0; i < a.size(); ++i)
                if (a[i].key != c[i].key || a[i].value != c[i].value || a[i].hard != c[i].hard) return false;
            return true;
        };
        // A task has to restart only if the edit changes what that task itself runs with. A change
        // that concerns the whole job (where it may be placed, its CPU class) restarts them all.
        // What counts is the setting in effect: sending back "ports: 1" for a server that already
        // had one port by default changes nothing.
        auto same_task = [](const JobInfo& a, const JobInfo& b, int index) {
            TaskSpec x = spec_of(a, index), y = spec_of(b, index);
            return x.cpu == y.cpu && x.ram_mb == y.ram_mb && x.disk_mb == y.disk_mb && x.ports == y.ports &&
                   x.workload == y.workload && health_checked(a, x) == health_checked(b, y);
        };
        bool placement = nj.distinct != j.distinct || !same_constraints(nj.constraints, j.constraints);
        bool cpu_class = appclass_of(nj) != appclass_of(j) || nj.slack_cpu != j.slack_cpu;
        bool whole_job = placement || cpu_class;
        bool respec = whole_job;
        for (int i = 0; i < std::min(j.task_count, nj.task_count) && !respec; ++i) respec = !same_task(j, nj, i);
        bool inplace = nj.priority != j.priority || nj.user != j.user;
        const JobInfo old = j;
        std::string before = job_status(j);
        int old_count = j.task_count;
        std::vector<std::string> changes;
        if (nj.priority != j.priority)
            changes.push_back("priority " + std::to_string(j.priority) + " -> " + std::to_string(nj.priority));
        if (nj.task_count != j.task_count)
            changes.push_back("tasks " + std::to_string(j.task_count) + " -> " + std::to_string(nj.task_count));
        if (nj.cpu != j.cpu) changes.push_back("cpu " + fmt(j.cpu) + " -> " + fmt(nj.cpu));
        if (nj.ram_mb != j.ram_mb)
            changes.push_back("ram " + std::to_string(j.ram_mb) + " -> " + std::to_string(nj.ram_mb) + " MB");
        if (nj.disk_mb != j.disk_mb)
            changes.push_back("disk " + std::to_string(j.disk_mb) + " -> " + std::to_string(nj.disk_mb) + " MB");
        TaskSpec was = spec_of(j, 0), now = spec_of(nj, 0);
        if (nj.overrides == j.overrides && now.ports != was.ports) changes.push_back("ports");
        if (nj.workload != j.workload) changes.push_back("workload");
        if (nj.overrides != j.overrides) changes.push_back("per-task overrides");
        if (cpu_class) changes.push_back("CPU class");
        if (nj.overrides == j.overrides && health_checked(nj, now) != health_checked(j, was)) changes.push_back("health checking");
        if (nj.type != j.type) changes.push_back("type " + j.type + " -> " + nj.type);
        if (nj.user != j.user) changes.push_back("user " + j.user + " -> " + nj.user);
        if (placement) changes.push_back("placement constraints");

        json before_spec = spec_json(j);
        int before_version = j.spec_version;
        nj.tasks = j.tasks;
        j = nj;  // spec_version, spec_counter and update were copied from j into nj by the caller

        bool live = !done(before);
        if (respec && live) {
            Update u;
            if (undo) {
                j.spec_version = j.update.before_version;  // tasks never updated already run this spec
                u.what = "undo";
            } else {
                j.spec_version = ++j.spec_counter;
                u.open = true;
                u.before = before_spec;
                u.before_version = before_version;
                u.what = "update";
            }
            u.rolling = true;
            u.max_unavailable = max_unavailable;
            u.max_disruptions = max_disruptions;
            u.started = now_s();
            j.update = u;
        } else if (respec) {
            j.spec_version = ++j.spec_counter;  // nothing is running: the next run uses the new spec
            j.update = Update{};
        }
        if (respec && live && !whole_job) {
            // Tasks whose own settings did not change keep running: they are up to date already.
            for (TaskId t : j.tasks) {
                TaskInfo& ti = tinfo_.at(t);
                if (!terminal(ti.state) && ti.spec_version == old.spec_version && ti.index < j.task_count &&
                    same_task(old, j, ti.index))
                    ti.spec_version = j.spec_version;
            }
        }

        int restarted = 0, in_place = 0, added = 0, removed = 0, to_restart = 0;
        if (live) {
            if (j.task_count < old_count) {  // scale down: drop the highest indices
                std::vector<TaskId> keep;
                for (TaskId t : j.tasks) {
                    if (tinfo_.at(t).index >= j.task_count) {
                        drop_task(t, actions);
                        removed++;
                    } else {
                        keep.push_back(t);
                    }
                }
                j.tasks = keep;
            }
            for (TaskId t : j.tasks) {
                const TaskInfo& ti = tinfo_.at(t);
                if (terminal(ti.state)) continue;
                if (inplace) {
                    update_in_place(j, t);
                    in_place++;
                }
                to_restart += respec && ti.spec_version != j.spec_version && placed(ti.state);
            }
            double release = before == "waiting" ? j.start_at : 0;
            for (int i = old_count; i < j.task_count; ++i, ++added) add_task(j, i, release);
            if (respec) restarted = roll(j, actions);
        }
        std::string what = changes.empty() ? "no changes" : changes[0];
        for (size_t i = 1; i < changes.size(); ++i) what += ", " + changes[i];
        bool rolling = respec && live && j.update.rolling;  // this edit started a roll-out that is still going
        std::string effect = !live          ? "takes effect on the next reschedule"
                             : rolling      ? "rolling: " + std::to_string(to_restart) + " task(s) to restart, at most " +
                                                  std::to_string(std::min(j.update.max_unavailable, j.task_count)) +
                                                  " down at once"
                             : to_restart   ? std::to_string(restarted) + " task(s) restarting"
                             : in_place     ? "applied in place, no restarts"
                                            : "applied";
        event("job", std::string(undo ? "undo of the last update of " : "updated ") + j.name + ": " + what + " (" + effect + ")");
        return {{"ok", true},         {"restarted", restarted}, {"to_restart", to_restart}, {"rolling", rolling},
                {"in_place", in_place}, {"added", added},       {"removed", removed},       {"status", job_status(j)},
                {"changes", changes}, {"effect", effect},       {"undoable", respec && live && !undo}};
    }

    // One step of a rolling update: moves outdated tasks to the job's current spec while keeping
    // at most max_unavailable of its tasks down, and stops at the disruption limit. Returns how
    // many running tasks it restarted.
    int roll(JobInfo& j, std::vector<Action>& actions) {
        Update& u = j.update;
        if (!u.rolling) return 0;
        int down = 0;
        std::vector<TaskId> outdated;
        for (TaskId id : j.tasks) {
            const TaskInfo& t = tinfo_.at(id);
            if (terminal(t.state)) continue;
            if (t.state != "running") down++;
            if (t.spec_version != j.spec_version) outdated.push_back(id);
        }
        const std::string why = u.what == "undo" ? "rolling back to the previous spec" : "rolling update to the new spec";
        int restarted = 0, waiting = 0, skipped = 0;
        for (TaskId id : outdated) {
            bool running = placed(tinfo_.at(id).state);
            if (running) {
                if (u.max_disruptions >= 0 && u.disruptions >= u.max_disruptions) {
                    skipped++;  // more disruptions than allowed: this change is skipped
                    continue;
                }
                if (down >= u.max_unavailable) {
                    waiting++;  // wait until the others are running again
                    continue;
                }
                u.disruptions++;
                down++;
                restarted++;
            }
            restart_task(j, id, -1, why, actions);
        }
        u.skipped = skipped;
        // The update is over once nothing is left to restart and the restarted tasks run again.
        bool settling = false;
        for (TaskId id : j.tasks) {
            const std::string& st = tinfo_.at(id).state;
            settling = settling || st == "pending" || st == "starting" || st == "installing";
        }
        if (waiting == 0 && !settling) {
            u.rolling = false;
            event("update", j.name + ": " + (u.what == "undo" ? "roll-back" : "rolling update") + " done, " +
                                std::to_string(u.disruptions) + " task(s) restarted" +
                                (u.skipped ? ", " + std::to_string(u.skipped) + " skipped (disruption limit)" : "") +
                                (u.open ? "; it can still be undone" : ""));
        }
        return restarted;
    }

    // Undoes or commits the job's open update.
    json update_job(JobId id, const json& b, int* status) {
        std::vector<Action> actions;
        json out;
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = jobs_.find(id);
            if (it == jobs_.end()) {
                *status = 404;
                return {{"error", "no such job"}};
            }
            JobInfo& j = it->second;
            std::string action = b.value("action", "");
            if (action != "undo" && action != "commit") {
                *status = 400;
                return {{"error", "action must be undo or commit"}};
            }
            if (!j.update.open) {
                *status = 400;
                return {{"error", j.name + " has no open update (it was committed, undone, or never updated)"}};
            }
            if (action == "commit") {
                j.update.open = false;
                j.update.before = json();
                event("update", j.name + ": update committed");
                out = {{"ok", true}, {"action", "committed"}};
            } else {
                JobInfo nj = j;
                std::string err;
                if (!apply_spec(j.update.before, nj, &err)) {
                    *status = 500;
                    return {{"error", "cannot restore the previous spec: " + err}};
                }
                out = apply_edit(j, nj, j.update.max_unavailable, -1, true, actions);
                out["action"] = "undone";
            }
            wake_.notify_all();
        }
        run_actions(actions);
        return out;
    }

    json reschedule_job(JobId id, const json& b, int* status) {
        std::vector<Action> actions;
        json out;
        std::string err;
        double when = requested_start(b, &err);
        if (!err.empty()) {
            *status = 400;
            return {{"error", err}};
        }
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = jobs_.find(id);
            if (it == jobs_.end()) {
                *status = 404;
                return {{"error", "no such job"}};
            }
            JobInfo& j = it->second;
            std::string st = job_status(j);
            std::string action, msg;
            std::string at = when > 0 ? in_words(when - now_s()) : "now";
            j.after.clear();
            if (done(st) && !admit(j, id, &err)) {
                *status = 403;
                event("admission", err);
                return {{"error", err}};
            }
            if (done(st)) {  // run it again from scratch
                for (TaskId t : j.tasks) {
                    held_.erase(t);
                    tinfo_.erase(t);
                }
                j.tasks.clear();
                j.runs++;
                for (int i = 0; i < j.task_count; ++i) add_task(j, i, when);
                action = "rerun";
                msg = "run #" + std::to_string(j.runs) + " of " + j.name + " starts " + at;
            } else if (st == "waiting") {  // move the start time
                for (TaskId t : j.tasks) {
                    auto h = held_.find(t);
                    if (h != held_.end()) h->second.release = when > 0 ? when : now_s();
                }
                action = "moved";
                msg = j.name + " now starts " + at;
            } else {  // live: stop and queue every live task again
                int n = 0;
                for (TaskId t : j.tasks) {
                    if (terminal(tinfo_.at(t).state)) continue;
                    restart_task(j, t, when, "rescheduled by user", actions);
                    n++;
                }
                action = "restarted";
                msg = std::to_string(n) + " task(s) of " + j.name + " restart " + at;
            }
            j.start_at = when;
            event("job", "rescheduled: " + msg);
            out = {{"ok", true}, {"action", action}, {"start_at", when}, {"message", msg}, {"status", job_status(j)}};
            wake_.notify_all();
        }
        run_actions(actions);
        return out;
    }

    json delete_job(JobId id, bool purge, int* status) {
        std::vector<Action> actions;
        json out;
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = jobs_.find(id);
            if (it == jobs_.end()) {
                *status = 404;
                return {{"error", "no such job"}};
            }
            JobInfo& j = it->second;
            if (j.type == "alloc") {
                for (const auto& [oid, other] : jobs_) {
                    if (other.alloc_set != j.name || done(job_status(other))) continue;
                    *status = 409;
                    return {{"error", "job " + other.name + " runs in alloc set " + j.name + ": remove it first"}};
                }
            }
            bool live = !done(job_status(j));
            int killed = 0;
            for (TaskId t : j.tasks) {
                TaskInfo& ti = tinfo_.at(t);
                if (terminal(ti.state)) continue;
                if (placed(ti.state) && ti.machine >= 0) actions.push_back(kill_action(ti.machine, t));
                finish(t, "killed", "job killed by user");
                killed++;
            }
            std::string name = j.name;
            if (!live || purge) {
                for (TaskId t : j.tasks) tinfo_.erase(t);
                jobs_.erase(it);
                event("job", live ? "killed and removed " + name : "removed " + name);
                out = {{"ok", true}, {"action", live ? "killed+removed" : "removed"}, {"killed", killed}};
            } else {
                event("job", "killed " + name + " (" + std::to_string(killed) + " task(s) stopped)");
                out = {{"ok", true}, {"action", "killed"}, {"killed", killed}};
            }
        }
        run_actions(actions);
        return out;
    }

    // ---- scheduler ---------------------------------------------------------------------------

    void scheduler_loop() {
        while (true) {
            std::vector<Action> actions;
            {
                std::unique_lock<std::mutex> lk(mu_);
                wake_.wait_for(lk, std::chrono::seconds(1));
                if (!leader_) continue;
                double now = now_s();
                release_waiting(now);
                for (auto& [id, j] : jobs_)
                    if (j.update.rolling) roll(j, actions);
                drain_step(now, actions);
                bool separate = now - sched_contact_ < kSchedulerGrace;
                if (separate != sched_separate_) {
                    sched_separate_ = separate;
                    event("scheduler", separate ? "scheduling is now done by the separate scheduler process"
                                                : "the scheduler process stopped answering: the Borgmaster schedules by itself again");
                }
                if (!separate && cell_.pending_count() > 0) schedule_pass(actions);
                place_in_allocs(actions);
                persist();
            }
            run_actions(actions);
        }
    }

    // Moves tasks whose wait is over into the pending queue: delayed starts, restart backoffs,
    // tasks from lost machines, and jobs that waited for another job to finish (§2.3).
    void release_waiting(double now) {
        for (auto& [id, j] : jobs_) {
            if (j.after.empty()) continue;
            const JobInfo* prior = find_job(j.after);
            std::string st = prior ? job_status(*prior) : "completed";
            if (st != "completed" && st != "failed" && st != "killed") continue;
            for (TaskId t : j.tasks) {
                auto h = held_.find(t);
                if (h == held_.end() || h->second.release < kNever) continue;
                if (st == "completed") h->second.release = now;
                else tinfo_.at(t).reason = "blocked: job " + j.after + " " + st + " (reschedule this job to start it anyway)";
            }
            if (st == "completed") {
                event("job", j.name + " starts now: " + j.after + " finished");
                j.after.clear();
            }
        }
        for (auto it = held_.begin(); it != held_.end();) {
            if (it->second.release > now) {
                ++it;
                continue;
            }
            auto ti = tinfo_.find(it->first);
            if (ti != tinfo_.end()) {
                TaskInfo& t = ti->second;
                enqueue(jobs_.at(t.job), it->second.task);
                if (t.state == "waiting") set_state(t, "pending", "released at its scheduled start");
                auto limited = t.reason.find("; rescheduling");
                if (limited != std::string::npos) t.reason.erase(limited);
            }
            it = held_.erase(it);
        }
    }

    // Jobs that run inside an alloc set (§2.4): task i goes into alloc i of the set (wrapping
    // around) once that alloc is reserved on a machine and has room for it. Tasks in one alloc
    // share its resources; if the alloc moves, they are rescheduled with it.
    void place_in_allocs(std::vector<Action>& actions) {
        for (auto& [jid, j] : jobs_) {
            if (!inner(j)) continue;
            const JobInfo* set = find_job(j.alloc_set);
            for (TaskId id : j.tasks) {
                TaskInfo& t = tinfo_.at(id);
                if (placed(t.state)) {  // is its alloc still where it was?
                    auto a = tinfo_.find(t.alloc);
                    bool ok = a != tinfo_.end() && placed(a->second.state) && a->second.machine == t.machine &&
                              a->second.attempt == t.alloc_attempt;
                    if (!ok) {
                        if (t.machine >= 0 && minfo_[t.machine].status == "up") actions.push_back(kill_action(t.machine, id));
                        requeue(id, "moved: its alloc is being rescheduled");
                    }
                    continue;
                }
                if (t.state != "pending" || held_.count(id)) continue;
                TaskId alloc_id = -1;
                if (set && set->type == "alloc")
                    for (TaskId a : set->tasks)
                        if (tinfo_.at(a).index == t.index % set->task_count) alloc_id = a;
                if (alloc_id < 0) {
                    t.reason = "waiting: alloc set " + j.alloc_set + " is gone";
                    continue;
                }
                const TaskInfo& a = tinfo_.at(alloc_id);
                std::string alloc_name = set->name + "/" + std::to_string(a.index);
                if (a.state != "running") {
                    t.reason = "waiting for alloc " + alloc_name + " to be reserved on a machine";
                    continue;
                }
                TaskSpec need = spec_of(j, t.index), size = spec_of(*set, a.index);
                Resources used;
                for (const auto& [oid, o] : tinfo_) {
                    if (o.alloc != alloc_id || !placed(o.state)) continue;
                    TaskSpec os = spec_of(jobs_.at(o.job), o.index);
                    used += Resources{os.cpu, static_cast<double>(os.ram_mb), static_cast<double>(os.disk_mb)};
                }
                if (used.cpu + need.cpu > size.cpu + kEps || used.ram + need.ram_mb > size.ram_mb + kEps ||
                    used.disk + need.disk_mb > size.disk_mb + kEps) {
                    t.reason = "waiting: alloc " + alloc_name + " has no room left for it";
                    continue;
                }
                t.machine = a.machine;
                t.attempt++;
                set_state(t, "starting", "placed in alloc " + alloc_name + " on " + machine_name(a.machine));
                t.alloc = alloc_id;
                t.alloc_attempt = a.attempt;
                t.ports = assign_ports(a.machine, need.ports);
                json body = start_body(t, j);
                body["alloc"] = alloc_id;
                actions.push_back({Action::Start, a.machine, minfo_[a.machine].address, t.id, t.attempt, body});
                event("schedule", task_name(id) + " -> alloc " + alloc_name + " on " + machine_name(a.machine));
            }
        }
    }

    // Machine maintenance (§4): moves tasks off draining machines one at a time, lowest priority
    // first, and never takes down more than `drain_max_down` tasks of one job at once.
    void drain_step(double now, std::vector<Action>& actions) {
        for (size_t i = 0; i < minfo_.size(); ++i) {
            MachineInfo& mi = minfo_[i];
            if (mi.drain != "draining") continue;
            MachineId m = static_cast<MachineId>(i);
            std::vector<TaskId> here;
            for (const auto& [id, t] : tinfo_)
                if (t.machine == m && placed(t.state)) here.push_back(id);
            if (here.empty()) {
                mi.drain = "drained";
                event("machine", machine_name(m) + " is drained: it runs nothing and can be taken down");
                continue;
            }
            if (now < next_drain_) continue;
            std::sort(here.begin(), here.end(), [&](TaskId a, TaskId b) {
                int pa = jobs_.at(tinfo_.at(a).job).priority, pb = jobs_.at(tinfo_.at(b).job).priority;
                return pa != pb ? pa < pb : a < b;
            });
            for (TaskId id : here) {
                const JobInfo& j = jobs_.at(tinfo_.at(id).job);
                if (inner(j)) continue;  // it moves when its alloc does
                int down = 0;
                for (TaskId other : j.tasks) {
                    const std::string& st = tinfo_.at(other).state;
                    down += !terminal(st) && st != "running";
                }
                if (down >= mi.drain_max_down) continue;  // this job already has enough tasks down
                actions.push_back(kill_action(m, id));
                requeue(id, "moved: " + machine_name(m) + " is draining for maintenance");
                event("drain", task_name(id) + " moved off " + machine_name(m) + " (maintenance)");
                next_drain_ = now + 1.0 / kDrainRate;
                break;
            }
        }
    }

    json drain_machine(MachineId m, const json& b, bool on, int* status) {
        std::lock_guard<std::mutex> g(mu_);
        if (m < 0 || m >= static_cast<MachineId>(minfo_.size())) {
            *status = 404;
            return {{"error", "no such machine"}};
        }
        MachineInfo& mi = minfo_[m];
        if (on) {
            mi.drain = "draining";
            mi.drain_max_down = std::max(1, b.is_object() ? b.value("max_down", 1) : 1);
            cell_.set_draining(m, true);
            event("machine", machine_name(m) + " is draining for maintenance: it takes no new tasks, and its tasks " +
                                 "move away one by one (at most " + std::to_string(mi.drain_max_down) +
                                 " task(s) of a job down at once)");
        } else {
            mi.drain.clear();
            cell_.set_draining(m, false);
            event("machine", machine_name(m) + " is back in service");
        }
        wake_.notify_all();
        return {{"ok", true}, {"drain", mi.drain}};
    }

    // One pass of the built-in scheduler over the pending queue.
    void schedule_pass(std::vector<Action>& actions) {
        ScheduleResult r = sched_.schedule(cell_);
        after_schedule(r, actions);
    }

    // What follows from a scheduling pass, whoever made it: preempted tasks are stopped and
    // queued again, placed tasks get their ports and are started on their machines.
    void after_schedule(const ScheduleResult& r, std::vector<Action>& actions) {
        last_stats_ = {{"placed", r.placed.size()},
                       {"preempted", r.preempted.size()},
                       {"unplaced", r.unplaced},
                       {"feasibility_checks", r.feasibility_checks},
                       {"score_computations", r.score_computations},
                       {"cache_hits", r.cache_hits},
                       {"elapsed_ms", r.elapsed_ms},
                       {"time", now_s()}};
        for (const auto& p : r.preempted) {
            TaskInfo& v = tinfo_.at(p.victim);
            v.preemptions++;
            v.started = 0;
            actions.push_back(kill_action(p.machine, p.victim));
            std::string by = task_name(p.by);
            set_state(v, "pending", "preempted by " + by + " on " + machine_name(p.machine));
            event("preempt", task_name(p.victim) + " preempted on " + machine_name(p.machine) + " by " + by);
        }
        for (const auto& p : r.placed) {
            TaskInfo& t = tinfo_.at(p.task);
            const JobInfo& j = jobs_.at(t.job);
            t.machine = p.machine;
            t.attempt++;
            set_state(t, "starting",
                      "placed on " + machine_name(p.machine) + " (" + policy_name(sched_.config().policy) + ")");
            t.ports = assign_ports(p.machine, static_cast<int>(cell_.task(p.task).limit.ports + 0.5));
            actions.push_back({Action::Start, p.machine, minfo_[p.machine].address, t.id, t.attempt, start_body(t, j)});
            event("schedule", task_name(t.id) + " -> " + machine_name(p.machine) +
                                  (t.ports.empty() ? "" : ", port " + std::to_string(t.ports[0])));
            const Machine& mach = cell_.machine(p.machine);
            Resources asked = mach.total_limits();
            if (asked.cpu > mach.capacity.cpu + kEps || asked.ram > mach.capacity.ram + kEps)
                event("reclaim", task_name(t.id) + " runs in reclaimed resources on " + mach.name + ": its tasks ask for " +
                                     fmt(asked.cpu) + " of " + fmt(mach.capacity.cpu) + " cpu and " + fmt(asked.ram, 0) +
                                     " of " + fmt(mach.capacity.ram, 0) + " MB, but use much less");
        }
        for (TaskId id : cell_.pending()) {
            TaskInfo& t = tinfo_.at(id);
            if (t.reason.rfind("preempted", 0) == 0 || t.reason.rfind("lost", 0) == 0 ||
                t.reason.rfind("restart", 0) == 0 || t.reason.rfind("moved", 0) == 0 ||
                t.reason.rfind("evicted", 0) == 0 || t.reason.rfind("rolling", 0) == 0)
                continue;  // keep the more informative reason
            t.reason = no_fit_reason(cell_.task(id));
        }
    }

    std::string no_fit_reason(const Task& t) const {
        int feasible_ignoring_resources = 0;
        for (const auto& m : cell_.machines()) {
            if (!m.up) continue;
            bool ok = true;
            for (const auto& c : t.constraints) {
                auto it = m.attributes.find(c.key);
                if (c.hard && (it == m.attributes.end() || it->second != c.value)) ok = false;
            }
            if (ok && t.limit.fits_in(m.capacity)) feasible_ignoring_resources++;
        }
        if (feasible_ignoring_resources == 0) return "no machine satisfies the constraints / size";
        return "waiting: no machine has enough free resources at this priority";
    }

    // Kills go first so preempted tasks release resources before new ones start.
    void run_actions(std::vector<Action>& actions) {
        std::stable_sort(actions.begin(), actions.end(),
                         [](const Action& a, const Action& b) { return a.kind == Action::Kill && b.kind != Action::Kill; });
        for (const auto& a : actions) {
            httplib::Client cli(a.address);
            cli.set_connection_timeout(1, 0);
            cli.set_read_timeout(2, 0);
            httplib::Result r = a.kind == Action::Kill ? cli.Delete("/tasks/" + std::to_string(a.task))
                                                       : cli.Post("/tasks", a.body.dump(), "application/json");
            if (a.kind == Action::Start && (!r || r->status != 200)) {
                std::lock_guard<std::mutex> g(mu_);
                auto it = tinfo_.find(a.task);
                if (it != tinfo_.end() && it->second.attempt == a.attempt && it->second.state == "starting") {
                    requeue(a.task, "restart: could not reach " + machine_name(a.machine));
                    event("error", "start of " + task_name(a.task) + " on " + machine_name(a.machine) + " failed");
                }
            }
        }
    }

    // ---- replicas and the elected master (§3.1) ------------------------------------------------
    //
    // A cell can run several Borgmaster replicas that share one state store (--state) and each
    // have a name (--replica). One of them is the elected master: the one that holds the lock in
    // the store, as Borg's master holds a lock in Chubby. It does all the work and records every
    // change. The others follow the change log, so they hold the same state, pass API requests
    // on to the elected master, and take over when its lock is released because it died.

    static json read_json_file(const std::string& path) {
        std::ifstream f(path);
        if (!f) return json();
        json j = json::parse(f, nullptr, false);
        return j.is_discarded() ? json() : j;
    }

    static void write_json_file(const std::string& path, const json& j) {
        std::string tmp = path + ".tmp";
        {
            std::ofstream f(tmp, std::ios::trunc);
            f << j.dump();
        }
        std::rename(tmp.c_str(), path.c_str());
    }

    bool try_lock() {
        if (lock_fd_ < 0) lock_fd_ = ::open((store_.dir() + "/master.lock").c_str(), O_RDWR | O_CREAT, 0644);
        return lock_fd_ >= 0 && ::flock(lock_fd_, LOCK_EX | LOCK_NB) == 0;
    }

    void replica_loop() {
        std::error_code ec;
        std::filesystem::create_directories(store_.dir() + "/replicas", ec);
        while (true) {
            write_json_file(store_.dir() + "/replicas/" + replica_ + ".json",
                            {{"name", replica_}, {"url", advertise_}, {"time", now_s()}, {"leader", leader_.load()}});
            if (!leader_) {
                if (try_lock()) become_leader();
                else follow_leader();
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }
    }

    // A follower keeps its copy of the state current, and remembers who the elected master is.
    void follow_leader() {
        std::lock_guard<std::mutex> g(mu_);
        store_.follow(follower_objects_, &follow_seq_);
        json m = read_json_file(store_.dir() + "/master.json");
        if (m.is_object()) {
            leader_url_ = m.value("url", "");
            leader_name_ = m.value("name", "");
            epoch_ = m.value("epoch", uint64_t{0});
        }
    }

    void become_leader() {
        std::lock_guard<std::mutex> g(mu_);
        store_.follow(follower_objects_, &follow_seq_);  // everything the last master recorded
        restore(follower_objects_);
        json previous = read_json_file(store_.dir() + "/master.json");
        std::string before = previous.is_object() ? previous.value("name", "") : "";
        epoch_ = (previous.is_object() ? previous.value("epoch", uint64_t{0}) : 0) + 1;
        write_json_file(store_.dir() + "/master.json",
                        {{"name", replica_}, {"url", advertise_}, {"epoch", epoch_}, {"since", now_s()}});
        leader_name_ = replica_;
        leader_url_ = advertise_;
        leader_ = true;
        restored_at_ = now_s();
        link_status_.clear();
        shards_.clear();
        event("master", replica_ + " is now the elected master (election " + std::to_string(epoch_) + ")" +
                            (before.empty() || before == replica_ ? "" : ": " + before + " stopped answering") +
                            "; running tasks were not disturbed");
        // A fresh snapshot starts a clean log (the old master may have died in the middle of a line).
        store_.snapshot(objects());
        persisted_.clear();
        for (const auto& [key, value] : objects()) persisted_[key] = value.dump();
        last_snapshot_ = now_s();
        wake_.notify_all();
    }

    // The replicas that wrote a heartbeat lately, by name.
    std::vector<json> live_replicas() const {
        std::vector<json> out;
        if (replica_.empty()) return out;
        std::error_code ec;
        double now = now_s();
        for (const auto& entry : std::filesystem::directory_iterator(store_.dir() + "/replicas", ec)) {
            if (entry.path().extension() != ".json") continue;
            json r = read_json_file(entry.path().string());
            if (r.is_object() && now - r.value("time", 0.0) < 4) out.push_back(r);
        }
        std::sort(out.begin(), out.end(),
                  [](const json& a, const json& b) { return a.value("name", "") < b.value("name", ""); });
        return out;
    }

    // Passes an API request on to the elected master and relays its answer.
    void forward(const httplib::Request& req, httplib::Response& res) {
        std::string url;
        {
            std::lock_guard<std::mutex> g(mu_);
            url = leader_url_;
        }
        httplib::Result r;
        if (!url.empty()) {
            httplib::Client cli(url);
            cli.set_connection_timeout(1, 0);
            cli.set_read_timeout(5, 0);
            httplib::Headers headers = {{"X-Forwarded-For", req.remote_addr}};
            const std::string type = req.has_header("Content-Type") ? req.get_header_value("Content-Type") : "application/json";
            if (req.method == "GET") r = cli.Get(req.target, headers);
            else if (req.method == "POST") r = cli.Post(req.target, headers, req.body, type);
            else if (req.method == "PATCH") r = cli.Patch(req.target, headers, req.body, type);
            else if (req.method == "DELETE") r = cli.Delete(req.target, headers, req.body, type);
        }
        if (!r) {
            res.status = 503;
            res.set_content(R"({"error":"no elected master answers right now: an election is in progress"})", "application/json");
            return;
        }
        res.status = r->status;
        res.set_content(r->body, r->has_header("Content-Type") ? r->get_header_value("Content-Type") : "application/json");
    }

    // ---- link shards (§3.3) -----------------------------------------------------------------------
    //
    // Every replica runs a link shard: a loop that polls some of the Borglets and hands their
    // reports to the elected master's state machine. A Borglet always reports its full state;
    // the shard passes it on only when it differs from what it passed on last time.

    struct Shard {
        std::vector<std::string> machines;
        uint64_t polls = 0, changes = 0;
    };

    // Which Borglets a replica's shard talks to. The machines are dealt out over the live
    // replicas; the split changes when a replica comes or goes, and after every election.
    json link_plan(const std::string& replica) {
        std::vector<std::string> names;
        for (const json& r : live_replicas()) names.push_back(r.value("name", ""));
        if (std::find(names.begin(), names.end(), replica_) == names.end()) names.push_back(replica_);
        std::sort(names.begin(), names.end());
        for (auto it = shards_.begin(); it != shards_.end();)
            it = std::find(names.begin(), names.end(), it->first) == names.end() ? shards_.erase(it) : std::next(it);
        for (const auto& name : names) shards_[name].machines.clear();
        json mine = json::array();
        for (size_t i = 0; i < minfo_.size(); ++i) {
            const std::string& owner = names[i % names.size()];
            shards_[owner].machines.push_back(cell_.machine(static_cast<MachineId>(i)).name);
            if (owner == replica) mine.push_back({{"id", i}, {"address", minfo_[i].address}});
        }
        return {{"epoch", epoch_}, {"machines", mine}};
    }

    // A Borglet's report with the usage numbers rounded, so that small wobbles in CPU and memory
    // use do not count as a change.
    static std::string signature(json s) {
        auto coarse = [](json& o, const char* key, double step) {
            if (o.is_object() && o.contains(key) && o[key].is_number()) o[key] = std::round(o[key].get<double>() / step) * step;
        };
        if (s.contains("usage")) {
            coarse(s["usage"], "cpu", 0.05);
            coarse(s["usage"], "ram", 8);
        }
        if (s.contains("tasks"))
            for (auto& t : s["tasks"]) {
                coarse(t, "cpu_usage", 0.05);
                coarse(t, "mem_mb", 8);
                coarse(t, "disk_mb", 1);
            }
        return s.dump();
    }

    void link_loop() {
        std::map<MachineId, std::string> last;  // what this shard passed on last, per machine
        uint64_t seen_epoch = ~uint64_t{0};
        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            // 1. Which Borglets are this shard's?
            json plan;
            std::string leader_url;
            if (leader_) {
                std::lock_guard<std::mutex> g(mu_);
                plan = link_plan(replica_);
            } else {
                {
                    std::lock_guard<std::mutex> g(mu_);
                    leader_url = leader_url_;
                }
                if (leader_url.empty()) continue;
                httplib::Client cli(leader_url);
                cli.set_connection_timeout(1, 0);
                cli.set_read_timeout(2, 0);
                auto r = cli.Get("/internal/link/plan?replica=" + replica_);
                plan = (r && r->status == 200) ? json::parse(r->body, nullptr, false) : json();
                if (!plan.is_object() || !plan.contains("machines")) continue;
            }
            if (plan.value("epoch", uint64_t{0}) != seen_epoch) {  // a new master: report everything in full
                seen_epoch = plan.value("epoch", uint64_t{0});
                last.clear();
            }
            std::vector<std::pair<MachineId, std::string>> targets;
            for (const auto& m : plan["machines"]) targets.push_back({m.value("id", MachineId{-1}), m.value("address", "")});

            // 2. Poll them, in parallel so that one dead machine does not slow the others.
            std::vector<std::thread> threads;
            std::vector<json> results(targets.size());
            for (size_t i = 0; i < targets.size(); ++i) {
                threads.emplace_back([&, i] {
                    httplib::Client cli(targets[i].second);
                    cli.set_connection_timeout(0, 700000);
                    cli.set_read_timeout(1, 0);
                    auto r = cli.Get("/status");
                    json j = (r && r->status == 200) ? json::parse(r->body, nullptr, false) : json();
                    results[i] = j.is_discarded() ? json() : j;
                });
            }
            for (auto& t : threads) t.join();

            // 3. Pass on only what changed.
            json reports = json::array();
            for (size_t i = 0; i < targets.size(); ++i) {
                MachineId m = targets[i].first;
                if (!results[i].is_object()) {
                    reports.push_back({{"machine", m}, {"missed", true}});
                    last.erase(m);
                    continue;
                }
                std::string sig = signature(results[i]);
                auto known = last.find(m);
                if (known != last.end() && known->second == sig) {
                    reports.push_back({{"machine", m}, {"same", true}});
                } else {
                    reports.push_back({{"machine", m}, {"status", results[i]}});
                    last[m] = std::move(sig);
                }
            }
            json body = {{"replica", replica_}, {"reports", reports}}, reply;
            if (leader_) {
                reply = link_report(body);
            } else {
                httplib::Client cli(leader_url);
                cli.set_connection_timeout(1, 0);
                cli.set_read_timeout(3, 0);
                auto r = cli.Post("/internal/link/report", body.dump(), "application/json");
                reply = (r && r->status == 200) ? json::parse(r->body, nullptr, false) : json();
            }
            if (reply.is_object() && reply.contains("resend"))
                for (const auto& m : reply["resend"]) last.erase(m.get<MachineId>());
        }
    }

    // The elected master's side: applies the reports of a link shard to the cell's state.
    json link_report(const json& b) {
        std::vector<Action> actions;
        json resend = json::array();
        {
            std::lock_guard<std::mutex> g(mu_);
            if (!leader_) return json{{"error", "not the elected master"}};
            Shard& shard = shards_[b.value("replica", "")];
            const json none = json::array();
            for (const auto& r : b.contains("reports") ? b["reports"] : none) {
                MachineId m = r.value("machine", MachineId{-1});
                if (m < 0 || m >= static_cast<MachineId>(minfo_.size())) continue;
                shard.polls++;
                if (r.value("missed", false)) {
                    on_missed_poll(m);
                    continue;
                }
                if (r.contains("status")) {
                    link_status_[m] = r["status"];
                    shard.changes++;
                }
                auto known = link_status_.find(m);
                if (known == link_status_.end()) {  // "no change", but this master never saw the report
                    resend.push_back(m);
                    continue;
                }
                on_status(m, known->second, actions);
            }
        }
        run_actions(actions);
        return {{"ok", true}, {"resend", resend}};
    }

    // ---- the separate scheduler process (§3.4) ------------------------------------------------

    // The changes to the cell since the scheduler process last asked: every machine and every
    // pending or placed task, sent only if it differs from what the scheduler already has.
    json sched_state(uint64_t since) {
        std::lock_guard<std::mutex> g(mu_);
        if (!leader_) return json();
        sched_contact_ = now_s();
        auto list = [](const Resources& r) { return json{r.cpu, r.ram, r.disk, r.ports}; };
        std::map<std::string, std::string> now;
        std::map<std::string, json> values;
        for (const auto& m : cell_.machines()) {
            json o = {{"name", m.name},       {"capacity", list(m.capacity)}, {"attributes", m.attributes},
                      {"up", m.up},           {"draining", m.draining},
                      {"packages", std::vector<std::string>(m.packages.begin(), m.packages.end())},
                      {"version", m.version}};
            values["m/" + std::to_string(m.id)] = o;
        }
        for (const auto& [id, t] : cell_.tasks()) {
            json o = {{"job", t.job},           {"index", t.index},
                      {"user", t.user},         {"priority", t.priority},
                      {"limit", list(t.limit)}, {"reservation", list(t.reservation)},
                      {"constraints", constraints_json(t.constraints)},
                      {"distinct", t.distinct_machines},
                      {"package", t.package},   {"avoid", t.avoid},
                      {"machine", t.machine}};
            values["t/" + std::to_string(id)] = o;
        }
        bool full = since == 0 || since != sched_version_;
        if (full) sched_sent_.clear();
        json put = json::object(), del = json::array();
        for (auto& [key, value] : values) {
            std::string dump = value.dump();
            auto old = sched_sent_.find(key);
            if (old == sched_sent_.end() || old->second != dump) put[key] = value;
            now[key] = std::move(dump);
        }
        for (const auto& [key, dump] : sched_sent_)
            if (!now.count(key)) del.push_back(key);
        if (full || !put.empty() || !del.empty()) sched_version_++;
        sched_sent_ = std::move(now);
        const SchedulerConfig& c = sched_.config();
        return {{"version", sched_version_},
                {"full", full},
                {"put", put},
                {"del", del},
                {"pending", cell_.pending_count()},
                {"config",
                 {{"policy", policy_name(c.policy)}, {"prod_min_priority", c.prod_min_priority},
                  {"reclamation", c.reclamation},   {"w_spread", c.w_spread},
                  {"w_package", c.w_package},       {"w_mix", c.w_mix}}}};
    }

    // Applies the assignments of a scheduling pass made on a copy of the cell. Each one is
    // accepted only if its machine is still exactly as the scheduler saw it (same version) and
    // the task still fits; the others are left for the scheduler's next pass.
    json sched_assign(const json& b) {
        std::vector<Action> actions;
        json out;
        {
            std::lock_guard<std::mutex> g(mu_);
            if (!leader_) return json{{"error", "not the elected master"}};
            sched_contact_ = now_s();
            ScheduleResult accepted;
            int rejected = 0;
            const json none = json::array();
            const json& preempted = b.contains("preempted") ? b["preempted"] : none;
            for (const auto& p : b.value("placed", json::array())) {
                TaskId id = p.value("task", TaskId{-1});
                MachineId m = p.value("machine", MachineId{-1});
                bool ok = cell_.has_task(id) && cell_.task(id).machine < 0 && m >= 0 &&
                          m < static_cast<MachineId>(cell_.machines().size()) &&
                          cell_.machine(m).version == p.value("machine_version", uint64_t{0}) &&
                          sched_.feasible(cell_, cell_.task(id), cell_.machine(m));
                std::vector<TaskId> victims;
                for (const auto& v : preempted) {
                    if (v.value("by", TaskId{-1}) != id) continue;
                    TaskId vid = v.value("victim", TaskId{-1});
                    ok = ok && cell_.has_task(vid) && cell_.task(vid).machine == m &&
                         cell_.task(vid).priority < cell_.task(id).priority;
                    victims.push_back(vid);
                }
                if (!ok) {
                    rejected++;
                    continue;
                }
                for (TaskId v : victims) {
                    cell_.unplace(v);
                    cell_.task(v).preemptions++;
                    accepted.preempted.push_back({v, m, id});
                }
                cell_.place(id, m);
                accepted.placed.push_back({id, m});
            }
            const json stats = b.value("stats", json::object());
            accepted.unplaced = stats.value("unplaced", size_t{0});
            accepted.feasibility_checks = stats.value("feasibility_checks", uint64_t{0});
            accepted.score_computations = stats.value("score_computations", uint64_t{0});
            accepted.cache_hits = stats.value("cache_hits", uint64_t{0});
            accepted.elapsed_ms = stats.value("elapsed_ms", 0.0);
            after_schedule(accepted, actions);
            sched_passes_++;
            sched_accepted_ += accepted.placed.size();
            sched_rejected_ += static_cast<uint64_t>(rejected);
            if (rejected)
                event("scheduler", std::to_string(rejected) + " assignment(s) of the scheduler process rejected: the cell " +
                                       "changed after it looked; they are reconsidered in its next pass");
            place_in_allocs(actions);
            persist();
            out = {{"accepted", accepted.placed.size()}, {"rejected", rejected}};
        }
        run_actions(actions);
        return out;
    }

    // ---- what the Borglets report -----------------------------------------------------------

    void on_missed_poll(MachineId m) {
        MachineInfo& mi = minfo_[m];
        if (++mi.misses < kMissesForDown || mi.status == "down") return;
        mi.status = "down";
        mi.cpu_usage = mi.mem_mb = 0;
        cell_.set_machine_up(m, false);
        // Tasks from an unreachable machine are re-queued at a limited rate, highest priority
        // first: the machine may only be cut off by the network, and a large failure must not
        // flood the scheduler (§4).
        std::vector<TaskId> lost;
        for (const auto& [id, t] : tinfo_)
            if (t.machine == m && placed(t.state)) lost.push_back(id);
        std::sort(lost.begin(), lost.end(), [&](TaskId a, TaskId b) {
            int pa = jobs_.at(tinfo_.at(a).job).priority, pb = jobs_.at(tinfo_.at(b).job).priority;
            return pa != pb ? pa > pb : a < b;
        });
        double now = now_s(), at = std::max(now, lost_next_);
        for (TaskId id : lost) {
            TaskInfo& t = tinfo_.at(id);
            const JobInfo& j = jobs_.at(t.job);
            cell_.remove_task(id);
            t.spec_version = j.spec_version;
            held_[id] = {at, make_task(j, t.index, id)};
            t.started = 0;
            set_state(t, "pending", "lost: " + machine_name(m) + " went down" +
                                        (at - now > 0.4 ? "; rescheduling " + in_words(at - now) + " (rate limit)" : ""));
            at += 1.0 / kLostRate;
        }
        lost_next_ = at;
        event("machine", machine_name(m) + " is DOWN (missed " + std::to_string(kMissesForDown) + " polls); " +
                             std::to_string(lost.size()) + " task(s) rescheduled" +
                             (lost.size() > 1 ? ", " + fmt(kLostRate, 0) + " per second" : ""));
        wake_.notify_all();
    }

    // A task that crashed on a machine is not placed there again (§4), unless that would leave
    // it nowhere to go: then the machines are not the problem.
    void note_crash(TaskInfo& t, MachineId m) {
        if (std::find(t.avoid.begin(), t.avoid.end(), m) != t.avoid.end()) return;
        size_t up = 0;
        for (const auto& mm : cell_.machines()) up += mm.up;
        if (t.avoid.size() + 1 >= up) {
            t.avoid.clear();
            return;
        }
        t.avoid.push_back(m);
        event("task", task_name(t.id) + " will not be placed on " + machine_name(m) + " again: it crashed there");
    }

    // Reaches into a running server task, to make its health check fail or to cause a load
    // spike. For demos: {action: sick | hang | ok | load | mem, index?, cpu?, mb?, seconds?}.
    json poke_job(JobId id, const json& b, int* status) {
        struct Target {
            std::string name, ip;
            int port;
        };
        std::vector<Target> targets;
        std::string path, action = b.value("action", "");
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = jobs_.find(id);
            if (it == jobs_.end()) {
                *status = 404;
                return {{"error", "no such job"}};
            }
            double secs = std::min(600.0, std::max(1.0, b.value("seconds", 20.0)));
            if (action == "sick" || action == "hang" || action == "ok") path = "/admin/" + action;
            else if (action == "load") path = "/load?cpu=" + fmt(b.value("cpu", 1.0)) + "&secs=" + fmt(secs, 0);
            else if (action == "mem") path = "/mem?mb=" + std::to_string(b.value("mb", 50)) + "&secs=" + fmt(secs, 0);
            else {
                *status = 400;
                return {{"error", "action must be sick, hang, ok, load or mem"}};
            }
            int only = b.value("index", -1);
            for (TaskId t : it->second.tasks) {
                const TaskInfo& ti = tinfo_.at(t);
                if (ti.state != "running" || ti.ports.empty() || ti.machine < 0) continue;
                if (only >= 0 && ti.index != only) continue;
                targets.push_back({task_name(t), minfo_[ti.machine].ip, ti.ports[0]});
            }
            if (targets.empty()) {
                *status = 400;
                return {{"error", "no running task of " + it->second.name + " listens on a port" +
                                      (only >= 0 ? " at index " + std::to_string(only) : "")}};
            }
            static const std::map<std::string, std::string> kWhat = {
                {"sick", "its health check now returns an error"}, {"hang", "it stopped answering its health check"},
                {"ok", "its health check answers again"},          {"load", "load spike"},
                {"mem", "memory spike"}};
            for (const auto& t : targets) event("poke", t.name + ": " + kWhat.at(action));
        }
        int reached = 0;
        for (const auto& t : targets) {
            httplib::Client cli(t.ip, t.port);
            cli.set_connection_timeout(1, 0);
            cli.set_read_timeout(2, 0);
            auto r = cli.Get(path);
            reached += r && r->status == 200;
        }
        if (reached == 0) {
            *status = 502;
            return {{"error", "the task(s) did not answer"}};
        }
        return {{"ok", true}, {"tasks", reached}};
    }

    // Runs a command inside a running task's jail, through its Borglet (§6.1: borgssh).
    json exec_task(TaskId id, const json& b, int* status) {
        std::string address, name;
        {
            std::lock_guard<std::mutex> g(mu_);
            auto it = tinfo_.find(id);
            if (it == tinfo_.end() || it->second.state != "running" || it->second.machine < 0) {
                *status = 404;
                return {{"error", "no running task with that id"}};
            }
            address = minfo_[it->second.machine].address;
            name = task_name(id);
            event("exec", name + ": " + b.value("cmd", "").substr(0, 80));
        }
        httplib::Client cli(address);
        cli.set_connection_timeout(1, 0);
        cli.set_read_timeout(6, 0);
        auto r = cli.Post("/tasks/" + std::to_string(id) + "/exec", json{{"cmd", b.value("cmd", "")}}.dump(), "application/json");
        if (!r) {
            *status = 502;
            return {{"error", "the task's machine did not answer"}};
        }
        *status = r->status;
        json out = json::parse(r->body, nullptr, false);
        return out.is_object() ? out : json{{"error", "bad answer from the Borglet"}};
    }

    // The Borg name service (§2.6): where each running task that listens on a port is now, and
    // whether it is healthy. Clients and load balancers read this to find a job's tasks.
    json bns_json(const std::string& job) {
        std::lock_guard<std::mutex> g(mu_);
        json names = json::array();
        for (const auto& [id, t] : tinfo_) {
            const JobInfo& j = jobs_.at(t.job);
            if (!job.empty() && j.name != job) continue;
            if (t.state != "running" || t.ports.empty() || t.machine < 0) continue;
            bool checked = health_checked(j, spec_of(j, t.index));
            names.push_back({{"name", bns_name(t, j)},
                             {"job", j.name},
                             {"index", t.index},
                             {"user", j.user},
                             {"machine", machine_name(t.machine)},
                             {"ip", minfo_[t.machine].ip},
                             {"port", t.ports[0]},
                             {"ports", t.ports},
                             {"healthy", checked ? t.healthy == 1 : true}});
        }
        return {{"cell", kCell}, {"names", names}};
    }

    void on_status(MachineId m, const json& s, std::vector<Action>& actions) {
        MachineInfo& mi = minfo_[m];
        Machine& mach = cell_.machine(m);
        mi.misses = 0;
        mi.last_seen = now_s();
        mi.cgroups = s.value("cgroups", false);
        mi.cpu_contended = s.value("cpu_contended", false);
        if (mi.status == "down") {
            mi.status = "up";
            cell_.set_machine_up(m, true);
            event("machine", mach.name + " is back UP");
            wake_.notify_all();
        }
        if (s.contains("usage")) {
            mi.cpu_usage = s["usage"].value("cpu", 0.0);
            mi.mem_mb = s["usage"].value("ram", 0.0);
        }
        std::unordered_set<std::string> pk;
        for (const auto& p : s.value("packages", json::array())) pk.insert(p.get<std::string>());
        if (pk != mach.packages) {
            mach.packages = std::move(pk);
            mach.version++;  // package locality is part of the score
        }

        std::set<TaskId> reported;
        for (const auto& r : s.value("tasks", json::array())) {
            TaskId id = r.value("id", 0LL);
            int64_t attempt = r.value("attempt", 0LL);
            std::string st = r.value("state", "");
            auto it = tinfo_.find(id);
            bool ours = it != tinfo_.end() && it->second.machine == m && it->second.attempt == attempt &&
                        placed(it->second.state);
            if (!ours) {
                // Stray task (e.g. a machine that came back after we moved its work): kill it.
                if (st == "running" || st == "installing") actions.push_back(kill_action(m, id));
                continue;
            }
            reported.insert(id);
            TaskInfo& t = it->second;
            const JobInfo& j = jobs_.at(t.job);
            std::string detail = r.value("detail", "");
            if (st == "installing" || st == "running") {
                if (t.state != st) {
                    if (st == "running") t.started = now_s();
                    TaskId alloc = t.alloc;
                    set_state(t, st, detail);
                    t.alloc = alloc;
                    if (st == "running")
                        event("task", j.type == "alloc" ? "alloc " + task_name(id) + " reserved on " + mach.name
                                                        : task_name(id) + " running on " + mach.name);
                }
                t.cpu_usage = r.value("cpu_usage", 0.0);
                t.mem_mb = r.value("mem_mb", 0.0);
                if (st == "running") update_reservation(id, t, now_s());
                t.disk_used_mb = r.value("disk_mb", 0.0);
                t.note = r.value("note", "");
                t.capped = r.value("capped", false);
                t.jailed = r.value("jailed", false);
                int healthy = r.value("healthy", -1);
                if (healthy != t.healthy) {
                    if (healthy == 0) event("health", task_name(id) + " is failing its health check on " + mach.name);
                    else if (healthy == 1 && t.healthy == 0) event("health", task_name(id) + " is healthy again");
                    t.healthy = healthy;
                }
            } else if (st == "evicted") {
                // The Borglet stopped it: the machine itself ran out of memory (§6.2), or the
                // alloc it ran in was released (§2.4).
                bool moved = detail.rfind("moved", 0) == 0;
                t.preemptions += !moved;
                requeue(id, detail);
                if (!moved) event("evict", task_name(id) + " " + detail);
                wake_.notify_all();
            } else if (j.type == "alloc" && (st == "failed" || st == "killed")) {
                requeue(id, "lost its reservation on " + mach.name);
                wake_.notify_all();
            } else if (st == "finished") {
                finish(id, "finished", detail);
                event("task", task_name(id) + " finished on " + mach.name);
            } else if (st == "failed" || st == "oom" || st == "killed") {
                std::string what = st == "oom" ? "OOM-killed" : (st == "killed" ? "killed" : "failed");
                if (j.type == "service") {
                    // Restart with exponential backoff (1, 2, 4, ... 30 s) so a crash loop does not
                    // monopolize the scheduler: the task is held out of the cell until then.
                    if (st == "failed") note_crash(t, m);
                    t.restarts++;
                    t.started = 0;
                    double delay = std::min(30.0, std::pow(2.0, std::min(t.restarts, 6) - 1));
                    cell_.remove_task(id);
                    t.spec_version = j.spec_version;
                    held_[id] = {now_s() + delay, make_task(j, t.index, id)};
                    set_state(t, "pending", "restart #" + std::to_string(t.restarts) + " in " + fmt(delay, 0) +
                                                "s (backoff) after " + what + ": " + detail);
                    event(st == "oom" ? "oom" : detail.rfind("unhealthy", 0) == 0 ? "health" : "task",
                          task_name(id) + " " + what + " on " + mach.name + " (" + detail + "); restarting in " +
                              fmt(delay, 0) + "s");
                } else {
                    finish(id, st, detail);
                    event(st == "oom" ? "oom" : "task", task_name(id) + " " + what + " on " + mach.name + " (" + detail + ")");
                }
                wake_.notify_all();
            }
        }
        // Started tasks the Borglet no longer knows about are lost.
        for (auto& [id, t] : tinfo_) {
            if (t.machine != m || reported.count(id) || !placed(t.state)) continue;
            if (now_s() - t.since > kLostAfter) {
                requeue(id, "lost: " + mach.name + " no longer reports it");
                event("task", task_name(id) + " lost on " + mach.name + "; rescheduling");
                wake_.notify_all();
            }
        }
    }

    // ---- durable state: snapshot + change log (§3.1) ---------------------------------------------

    static json constraints_json(const std::vector<Constraint>& cs) {
        json out = json::array();
        for (const auto& c : cs) out.push_back({{"key", c.key}, {"value", c.value}, {"hard", c.hard}});
        return out;
    }

    static json job_to_json(const JobInfo& j) {
        const Update& u = j.update;
        return {{"id", j.id},
                {"name", j.name},
                {"spec", spec_json(j)},
                {"submitted", j.submitted},
                {"start_at", j.start_at},
                {"runs", j.runs},
                {"tasks", j.tasks},
                {"after", j.after},
                {"alloc_set", j.alloc_set},
                {"spec_version", j.spec_version},
                {"spec_counter", j.spec_counter},
                {"update",
                 {{"open", u.open},
                  {"rolling", u.rolling},
                  {"before", u.before},
                  {"before_version", u.before_version},
                  {"max_unavailable", u.max_unavailable},
                  {"max_disruptions", u.max_disruptions},
                  {"disruptions", u.disruptions},
                  {"skipped", u.skipped},
                  {"started", u.started},
                  {"what", u.what}}}};
    }

    static bool job_from_json(const json& o, JobInfo* j) {
        std::string err;
        j->id = o.value("id", JobId{0});
        j->name = o.value("name", "");
        j->alloc_set = o.value("alloc_set", "");
        if (!apply_spec(o.value("spec", json::object()), *j, &err)) return false;
        j->submitted = o.value("submitted", 0.0);
        j->start_at = o.value("start_at", 0.0);
        j->runs = o.value("runs", 1);
        j->tasks = o.value("tasks", std::vector<TaskId>{});
        j->after = o.value("after", "");
        j->spec_version = o.value("spec_version", 1);
        j->spec_counter = o.value("spec_counter", 1);
        const json u = o.value("update", json::object());
        j->update.open = u.value("open", false);
        j->update.rolling = u.value("rolling", false);
        j->update.before = u.value("before", json());
        j->update.before_version = u.value("before_version", 0);
        j->update.max_unavailable = u.value("max_unavailable", 1);
        j->update.max_disruptions = u.value("max_disruptions", -1);
        j->update.disruptions = u.value("disruptions", 0);
        j->update.skipped = u.value("skipped", 0);
        j->update.started = u.value("started", 0.0);
        j->update.what = u.value("what", "");
        return j->id > 0;
    }

    // What is kept of a task. Usage numbers, health and notes are not: the Borglets report them
    // again within a second.
    json task_to_json(const TaskInfo& t) const {
        auto h = held_.find(t.id);
        return {{"id", t.id},
                {"job", t.job},
                {"index", t.index},
                {"state", t.state},
                {"reason", t.reason},
                {"machine", t.machine},
                {"attempt", t.attempt},
                {"restarts", t.restarts},
                {"preemptions", t.preemptions},
                {"since", t.since},
                {"started", t.started},
                {"ended", t.ended},
                {"ports", t.ports},
                {"spec_version", t.spec_version},
                {"avoid", t.avoid},
                {"alloc", t.alloc},
                {"alloc_attempt", t.alloc_attempt},
                {"release", h != held_.end() ? json(h->second.release) : json()}};
    }

    json machine_to_json(MachineId id) const {
        const Machine& m = cell_.machine(id);
        const MachineInfo& mi = minfo_[id];
        return {{"id", id},
                {"name", m.name},
                {"capacity", {m.capacity.cpu, m.capacity.ram, m.capacity.disk, m.capacity.ports}},
                {"attributes", m.attributes},
                {"address", mi.address},
                {"ip", mi.ip},
                {"port_lo", mi.port_lo},
                {"port_hi", mi.port_hi},
                {"status", mi.status},
                {"drain", mi.drain},
                {"drain_max_down", mi.drain_max_down}};
    }

    json meta_to_json() const {
        json quotas = json::array();
        for (const auto& [user, bands] : quota_)
            for (const auto& [bnd, q] : bands)
                quotas.push_back({{"user", user}, {"band", bnd}, {"cpu", q.cpu}, {"ram_mb", q.ram_mb}, {"disk_mb", q.disk_mb}});
        return {{"next_job", next_job_},
                {"policy", policy_name(sched_.config().policy)},
                {"reclamation", reclaim_.enabled},
                {"reclaim_warmup", reclaim_.warmup},
                {"quotas", quotas}};
    }

    // The cell's state as stored objects, by key.
    std::map<std::string, json> objects() const {
        std::map<std::string, json> out;
        out["meta"] = meta_to_json();
        for (const auto& [id, j] : jobs_) out["job/" + std::to_string(id)] = job_to_json(j);
        for (const auto& [id, t] : tinfo_) out["task/" + std::to_string(id)] = task_to_json(t);
        for (size_t i = 0; i < minfo_.size(); ++i)
            out["machine/" + std::to_string(i)] = machine_to_json(static_cast<MachineId>(i));
        for (const auto& e : events_)
            out["event/" + std::to_string(e.seq)] = {{"seq", e.seq}, {"time", e.time}, {"kind", e.kind}, {"msg", e.msg}};
        return out;
    }

    // Records every object that changed since the last call in the change log, and writes a
    // fresh snapshot now and then. Called with mu_ held, at least once a second.
    void persist() {
        if (!store_.enabled() || !leader_) return;
        std::map<std::string, json> now = objects();
        for (const auto& [key, value] : now) {
            std::string dump = value.dump();
            auto old = persisted_.find(key);
            if (old != persisted_.end() && old->second == dump) continue;
            store_.append(key, &value);
            persisted_[key] = std::move(dump);
        }
        for (auto it = persisted_.begin(); it != persisted_.end();) {
            if (now.count(it->first)) {
                ++it;
                continue;
            }
            store_.append(it->first, nullptr);
            it = persisted_.erase(it);
        }
        store_.flush();
        if (store_.log_entries() >= 500 || (store_.log_entries() > 0 && now_s() - last_snapshot_ > 60)) {
            store_.snapshot(now);
            last_snapshot_ = now_s();
        }
    }

    // Rebuilds the in-memory state from stored objects (after a restart, or when this replica
    // becomes the elected master). Tasks that were on machines are put back where they were;
    // the next polls tell what really happened to them meanwhile.
    void restore(const std::map<std::string, json>& stored) {
        cell_ = Cell();
        minfo_.clear();
        jobs_.clear();
        tinfo_.clear();
        held_.clear();
        events_.clear();
        quota_.clear();
        persisted_.clear();
        auto each = [&](const std::string& prefix, const std::function<void(const json&)>& fn) {
            std::vector<std::pair<int64_t, const json*>> found;
            for (auto it = stored.lower_bound(prefix); it != stored.end() && it->first.rfind(prefix, 0) == 0; ++it)
                found.push_back({std::stoll(it->first.substr(prefix.size())), &it->second});
            std::sort(found.begin(), found.end());
            for (const auto& [id, value] : found) fn(*value);
        };
        auto meta = stored.find("meta");
        if (meta != stored.end()) {
            const json& m = meta->second;
            next_job_ = m.value("next_job", JobId{1});
            SchedulerConfig c = sched_.config();
            Policy p;
            if (parse_policy(m.value("policy", "hybrid"), &p)) c.policy = p;
            reclaim_.enabled = c.reclamation = m.value("reclamation", false);
            reclaim_.warmup = m.value("reclaim_warmup", reclaim_.warmup);
            sched_.set_config(c);
            for (const auto& q : m.value("quotas", json::array()))
                quota_[q.value("user", "")][q.value("band", "")] = {q.value("cpu", -1.0), q.value("ram_mb", -1.0),
                                                                    q.value("disk_mb", -1.0)};
        }
        each("machine/", [&](const json& o) {
            std::vector<double> cap = o.value("capacity", std::vector<double>{1, 512, 2048, 0});
            cap.resize(4);
            MachineId id = cell_.add_machine(o.value("name", ""), Resources{cap[0], cap[1], cap[2], cap[3]},
                                             o.value("attributes", std::map<std::string, std::string>{}));
            MachineInfo mi;
            mi.address = o.value("address", "");
            mi.ip = o.value("ip", "");
            mi.port_lo = o.value("port_lo", 0);
            mi.port_hi = o.value("port_hi", -1);
            mi.status = o.value("status", "up");
            mi.drain = o.value("drain", "");
            mi.drain_max_down = o.value("drain_max_down", 1);
            mi.last_seen = now_s();
            minfo_.push_back(mi);
            cell_.set_machine_up(id, mi.status == "up");
            cell_.set_draining(id, !mi.drain.empty());
        });
        each("job/", [&](const json& o) {
            JobInfo j;
            if (job_from_json(o, &j)) jobs_[j.id] = std::move(j);
        });
        TaskId max_id = 0;
        std::map<TaskId, double> releases;
        each("task/", [&](const json& o) {
            TaskInfo t;
            t.id = o.value("id", TaskId{0});
            t.job = o.value("job", JobId{0});
            if (!jobs_.count(t.job)) return;
            t.index = o.value("index", 0);
            t.state = o.value("state", "pending");
            t.reason = o.value("reason", "");
            t.machine = o.value("machine", MachineId{-1});
            t.attempt = o.value("attempt", int64_t{0});
            t.restarts = o.value("restarts", 0);
            t.preemptions = o.value("preemptions", 0);
            t.since = o.value("since", 0.0);
            t.started = o.value("started", 0.0);
            t.ended = o.value("ended", 0.0);
            t.ports = o.value("ports", std::vector<int>{});
            t.spec_version = o.value("spec_version", 1);
            t.avoid = o.value("avoid", std::vector<MachineId>{});
            t.alloc = o.value("alloc", TaskId{0});
            t.alloc_attempt = o.value("alloc_attempt", int64_t{0});
            if (t.machine >= static_cast<MachineId>(minfo_.size())) t.machine = -1;
            max_id = std::max(max_id, t.id);
            if (o.contains("release") && o["release"].is_number()) releases[t.id] = o["release"].get<double>();
            tinfo_[t.id] = std::move(t);
        });
        for (auto& [id, t] : tinfo_) {
            if (terminal(t.state)) continue;
            const JobInfo& j = jobs_.at(t.job);
            auto rel = releases.find(id);
            if (rel != releases.end()) {
                held_[id] = {rel->second, make_task(j, t.index, id)};
            } else if (!inner(j)) {
                cell_.add_task(make_task(j, t.index, id));
                if (placed(t.state) && t.machine >= 0 && cell_.machine(t.machine).up) cell_.place(id, t.machine);
                else if (placed(t.state)) set_state(t, "pending", "lost: its machine was down when the Borgmaster restarted");
            }
        }
        cell_.ensure_next_id(max_id + 1);
        each("event/", [&](const json& o) {
            events_.push_back({o.value("seq", uint64_t{0}), o.value("time", 0.0), o.value("kind", ""), o.value("msg", "")});
            event_seq_ = std::max(event_seq_, events_.back().seq);
        });
        for (const auto& [key, value] : stored) persisted_[key] = value.dump();
        last_snapshot_ = now_s();
    }

    // ---- JSON views --------------------------------------------------------------------------

    json state_json() {
        std::lock_guard<std::mutex> g(mu_);
        json machines = json::array();
        Resources cap_total, alloc_total;
        for (const auto& m : cell_.machines()) {
            const MachineInfo& mi = minfo_[m.id];
            Resources alloc = m.total_limits(), prod = m.committed(kProdMin, false);
            if (m.up) {
                cap_total += m.capacity;
                alloc_total += alloc;
            }
            json tasks = json::array();
            int ports_used = 0;
            for (TaskId t : m.tasks) tasks.push_back(t);
            for (const auto& [tid, ti] : tinfo_) {
                if (ti.machine != m.id || !placed(ti.state)) continue;
                ports_used += static_cast<int>(ti.ports.size());
                if (ti.alloc) tasks.push_back(tid);  // runs inside an alloc on this machine
            }
            Resources reserved = m.committed(INT32_MIN, true);
            machines.push_back({{"id", m.id},
                                {"name", m.name},
                                {"address", mi.address},
                                {"ip", mi.ip},
                                {"drain", mi.drain},
                                {"cpu_contended", mi.cpu_contended},
                                {"ports", {{"lo", mi.port_lo}, {"hi", mi.port_hi}, {"used", ports_used}}},
                                {"reserved", {{"cpu", reserved.cpu}, {"ram", reserved.ram}}},
                                {"status", mi.status},
                                {"cgroups", mi.cgroups},
                                {"last_seen", mi.last_seen},
                                {"capacity", {{"cpu", m.capacity.cpu}, {"ram", m.capacity.ram}, {"disk", m.capacity.disk}}},
                                {"allocated", {{"cpu", alloc.cpu}, {"ram", alloc.ram}, {"disk", alloc.disk}}},
                                {"allocated_prod", {{"cpu", prod.cpu}, {"ram", prod.ram}}},
                                {"usage", {{"cpu", mi.cpu_usage}, {"ram", mi.mem_mb}}},
                                {"attributes", m.attributes},
                                {"packages", std::vector<std::string>(m.packages.begin(), m.packages.end())},
                                {"tasks", tasks}});
        }
        json jobs = json::array();
        std::map<std::string, int> totals;
        for (const auto& [id, j] : jobs_) {
            std::map<std::string, int> counts;
            double started_at = 0, finished_at = 0;
            for (TaskId t : j.tasks) {
                const TaskInfo& ti = tinfo_.at(t);
                counts[ti.state]++;
                if (ti.started > 0 && (started_at == 0 || ti.started < started_at)) started_at = ti.started;
                finished_at = std::max(finished_at, ti.ended);
            }
            for (auto& [k, v] : counts) totals[k] += v;
            std::string status = job_status(j);
            int outdated = 0;
            for (TaskId t : j.tasks) {
                const TaskInfo& ti = tinfo_.at(t);
                outdated += !terminal(ti.state) && ti.spec_version != j.spec_version;
            }
            TaskSpec first = spec_of(j, 0);
            const Update& u = j.update;
            json update = {{"open", u.open},
                           {"rolling", u.rolling},
                           {"what", u.what},
                           {"max_unavailable", std::min(u.max_unavailable, std::max(1, j.task_count))},
                           {"max_disruptions", u.max_disruptions},
                           {"disruptions", u.disruptions},
                           {"skipped", u.skipped},
                           {"outdated", outdated}};
            json cons = json::array();
            for (const auto& c : j.constraints) cons.push_back({{"key", c.key}, {"value", c.value}, {"hard", c.hard}});
            jobs.push_back({{"id", j.id},
                            {"name", j.name},
                            {"user", j.user},
                            {"type", j.type},
                            {"priority", j.priority},
                            {"band", band(j.priority)},
                            {"tasks", j.task_count},
                            {"cpu", j.cpu},
                            {"ram_mb", j.ram_mb},
                            {"disk_mb", j.disk_mb},
                            {"ports", first.ports},
                            {"appclass", appclass_of(j)},
                            {"slack_cpu", j.slack_cpu},
                            {"health", health_checked(j, first)},
                            {"after", j.after},
                            {"alloc_set", j.alloc_set},
                            {"overrides", j.overrides},
                            {"update", update},
                            {"workload", j.workload},
                            {"duration", workload_duration(j.workload)},
                            {"constraints", cons},
                            {"distinct", j.distinct},
                            {"submitted", j.submitted},
                            {"start_at", j.start_at},
                            {"started_at", started_at},
                            {"finished_at", done(status) ? finished_at : 0.0},
                            {"runs", j.runs},
                            {"status", status},
                            {"counts", counts},
                            {"done", done(status)}});
        }
        json tasks = json::array();
        for (const auto& [id, t] : tinfo_) {
            const JobInfo& j = jobs_.at(t.job);
            auto h = held_.find(id);
            TaskSpec spec = spec_of(j, t.index);
            Resources resv = cell_.has_task(id) ? cell_.task(id).reservation
                                                : Resources{spec.cpu, static_cast<double>(spec.ram_mb)};
            json avoid = json::array();
            for (MachineId m : t.avoid) avoid.push_back(machine_name(m));
            std::string alloc_name;
            if (t.alloc && tinfo_.count(t.alloc)) alloc_name = task_name(t.alloc);
            json inside = json::array();  // for an alloc: the tasks that run in it
            if (j.type == "alloc")
                for (const auto& [oid, o] : tinfo_)
                    if (o.alloc == id && placed(o.state)) inside.push_back(oid);
            tasks.push_back({{"id", id},
                             {"name", bns_name(t, j)},
                             {"type", j.type},
                             {"alloc", t.alloc},
                             {"alloc_name", alloc_name},
                             {"inside", inside},
                             {"reservation", {{"cpu", resv.cpu}, {"ram_mb", resv.ram}}},
                             {"ports", t.ports},
                             {"healthy", t.healthy},
                             {"note", t.note},
                             {"capped", t.capped},
                             {"jailed", t.jailed},
                             {"outdated", !terminal(t.state) && t.spec_version != j.spec_version},
                             {"avoid", avoid},
                             {"disk_mb", spec.disk_mb},
                             {"disk_used_mb", t.disk_used_mb},
                             {"job", t.job},
                             {"job_name", j.name},
                             {"index", t.index},
                             {"priority", j.priority},
                             {"band", band(j.priority)},
                             {"state", t.state},
                             {"reason", t.reason},
                             {"machine", t.machine},
                             {"machine_name", machine_name(t.machine)},
                             {"attempt", t.attempt},
                             {"restarts", t.restarts},
                             {"preemptions", t.preemptions},
                             {"cpu", spec.cpu},
                             {"ram_mb", spec.ram_mb},
                             {"cpu_usage", t.cpu_usage},
                             {"mem_mb", t.mem_mb},
                             {"since", t.since},
                             {"started", t.started},
                             {"ended", t.ended},
                             {"release", h != held_.end() && h->second.release < kNever ? h->second.release : 0.0}});
        }
        json replicas = json::array(), shards = json::array();
        for (const json& r : live_replicas())
            replicas.push_back({{"name", r.value("name", "")}, {"url", r.value("url", "")}, {"elected", r.value("name", "") == replica_}});
        for (const auto& [name, shard] : shards_)
            shards.push_back({{"replica", name}, {"machines", shard.machines}, {"polls", shard.polls}, {"changes", shard.changes}});
        return {{"time", now_s()},
                {"cell", kCell},
                {"reclamation", {{"enabled", reclaim_.enabled}, {"warmup", reclaim_.warmup}, {"margin", reclaim_.margin}}},
                {"master",
                 {{"name", replica_},
                  {"election", epoch_},
                  {"replicas", replicas},
                  {"shards", shards},
                  {"scheduler",
                   {{"separate", sched_separate_},
                    {"passes", sched_passes_},
                    {"accepted", sched_accepted_},
                    {"rejected", sched_rejected_}}},
                  {"checkpoint",
                   {{"enabled", store_.enabled()},
                    {"seq", store_.seq()},
                    {"snapshot_seq", store_.snapshot_seq()},
                    {"log_entries", store_.log_entries()},
                    {"restored_at", restored_at_}}}}},
                {"policy", policy_name(sched_.config().policy)},
                {"prod_min_priority", kProdMin},
                {"capacity", {{"cpu", cap_total.cpu}, {"ram", cap_total.ram}}},
                {"allocated", {{"cpu", alloc_total.cpu}, {"ram", alloc_total.ram}}},
                {"task_counts", totals},
                {"scheduler", last_stats_},
                {"machines", machines},
                {"jobs", jobs},
                {"tasks", tasks}};
    }

    json events_json(uint64_t since) {
        std::lock_guard<std::mutex> g(mu_);
        json out = json::array();
        for (const auto& e : events_)
            if (e.seq > since) out.push_back({{"seq", e.seq}, {"time", e.time}, {"kind", e.kind}, {"msg", e.msg}});
        return {{"events", out}, {"last", event_seq_}};
    }

    std::mutex mu_;
    std::condition_variable wake_;
    Cell cell_;
    Scheduler sched_;
    std::vector<MachineInfo> minfo_;  // indexed by MachineId
    std::map<JobId, JobInfo> jobs_;
    std::map<TaskId, TaskInfo> tinfo_;
    std::map<TaskId, Held> held_;  // delayed starts and crash-restart backoffs
    std::deque<Event> events_;
    uint64_t event_seq_ = 0;
    JobId next_job_ = 1;
    json last_stats_ = json::object();
    std::map<std::string, std::map<std::string, Quota>> quota_;  // user ("*" = default) -> band -> quota
    Reclaim reclaim_;
    Store store_;                                  // snapshot + change log of the state (§3.1)
    std::map<std::string, std::string> persisted_; // what the store holds, by key
    double last_snapshot_ = 0, restored_at_ = 0;
    std::atomic<bool> leader_{true};               // this replica is the elected master
    std::string replica_, advertise_;              // this replica's name ("" = the only Borgmaster) and URL
    int lock_fd_ = -1;                             // the master lock in the store
    uint64_t epoch_ = 0;                           // how many elections there have been
    std::string leader_name_, leader_url_;         // the elected master, as a follower knows it
    std::map<std::string, json> follower_objects_; // a follower's copy of the state
    uint64_t follow_seq_ = 0;
    std::map<MachineId, json> link_status_;        // the last full report of each Borglet
    std::map<std::string, Shard> shards_;          // link shards by replica
    double sched_contact_ = 0;                     // when the separate scheduler process last asked for state
    bool sched_separate_ = false;                  // it does the scheduling right now
    uint64_t sched_version_ = 0;                   // version of the state the scheduler process has
    std::map<std::string, std::string> sched_sent_; // ...and that state, by key
    uint64_t sched_passes_ = 0, sched_accepted_ = 0, sched_rejected_ = 0;
    std::vector<TaskId> reset_reservations_;
    double lost_next_ = 0;   // when the next task from a lost machine may be re-queued
    double next_drain_ = 0;  // when the next task may be moved off a draining machine
};

}  // namespace

int main(int argc, char** argv) {
    ::signal(SIGPIPE, SIG_IGN);
    int port = 8080;
    std::string ui = "ui", state, replica, advertise;
    Policy policy = Policy::Hybrid;
    for (int i = 1; i + 1 < argc; i += 2) {
        std::string a = argv[i], v = argv[i + 1];
        if (a == "--port") port = std::stoi(v);
        else if (a == "--ui") ui = v;
        else if (a == "--state") state = v;
        else if (a == "--replica") replica = v;
        else if (a == "--advertise") advertise = v;
        else if (a == "--policy" && !parse_policy(v, &policy)) {
            std::cerr << "unknown policy " << v << "\n";
            return 2;
        }
    }
    if (!replica.empty() && state.empty()) {
        std::cerr << "--replica needs --state: the replicas of a cell share one state directory\n";
        return 2;
    }
    if (advertise.empty()) advertise = "http://127.0.0.1:" + std::to_string(port);
    Master master(policy, state, replica, advertise);
    master.serve(port, ui);
    return 0;
}
