// borgmaster: the live cell's central controller (§3.1). Single replica, state in memory (no Paxos).
//
//  - accepts, edits, reschedules and kills jobs over a REST API (used by the web UI)
//  - runs the Borg scheduler from core/ every second on the pending queue
//  - starts/kills tasks on Borglets and polls every Borglet for state and usage (§3.3)
//  - marks a machine down after missed polls and reschedules its tasks; kills stray tasks
//    on machines that come back
//  - serves the terminal UI (ui/) and the simulation results (results/)
//
// REST API
//   GET    /api/state                  machines, jobs (status, timestamps), tasks
//   GET    /api/events?since=N         event log
//   POST   /api/jobs                   submit {name, user, type, priority, tasks, cpu, ram_mb, workload,
//                                      constraints, distinct, delay | start_at}
//   PATCH  /api/jobs/<id>              edit fields of a job; restarts tasks only when needed (§2.3)
//   POST   /api/jobs/<id>/reschedule   {delay | start_at}: move a waiting job's start, restart a
//                                      live job, or run a finished job again
//   DELETE /api/jobs/<id>[?purge=1]    kill a live job (kept in history) or remove a finished one;
//                                      purge kills and removes in one go
//   POST   /api/config                 {policy}
//   POST   /api/machines/<id>/fail     {seconds}: simulate a machine failure
//   POST   /api/register               Borglet registration
#include <signal.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <filesystem>
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

using json = nlohmann::json;
using namespace borg;

namespace {

constexpr int kProdMin = 200;    // priority bands: free <100, batch 100-199, production 200-299, monitoring 300+
constexpr int kMissesForDown = 3;
constexpr double kLostAfter = 6;  // seconds a started task may be missing from its Borglet's report
constexpr double kMaxDelay = 7 * 24 * 3600;

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

struct JobInfo {
    JobId id = 0;
    std::string name, user, type;  // type: service (restarted on failure) | batch (runs to completion)
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
};

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
    double cpu_usage = 0, mem_mb = 0;
};

struct MachineInfo {
    std::string address;
    std::string status = "up";  // up | down
    int misses = 0;
    double last_seen = 0;
    double cpu_usage = 0, mem_mb = 0;
    bool cgroups = false;
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
        if (b.contains("constraints")) {
            j.constraints.clear();
            for (const auto& c : b["constraints"])
                if (c.is_object() && !c.value("key", "").empty())
                    j.constraints.push_back({c.value("key", ""), c.value("value", ""), c.value("hard", true)});
        }
        if (j.user.empty()) j.user = "user";
        if (!j.workload.is_object()) j.workload = json::object();
        static const std::set<std::string> kWorkloads = {"service", "sleep", "cpu", "mem", "crash"};
        std::string wt = j.workload.value("type", "");
        if (j.type != "service" && j.type != "batch") *err = "type must be service or batch";
        else if (j.priority < 0 || j.priority > 999) *err = "priority must be 0..999";
        else if (j.task_count < 1 || j.task_count > 200) *err = "tasks must be 1..200";
        else if (!(j.cpu > 0) || j.cpu > 64) *err = "cpu must be more than 0 cores";
        else if (j.ram_mb < 1 || j.ram_mb > (1 << 20)) *err = "ram_mb must be at least 1";
        else if (!kWorkloads.count(wt)) *err = "workload.type must be service, sleep, cpu, mem or crash";
        else if (wt != "service" && !(j.workload.value("duration", 0.0) > 0))
            *err = "workload.duration must be more than 0 seconds";
        else if (wt == "cpu" && (j.workload.value("threads", 1) < 1 || j.workload.value("threads", 1) > 16))
            *err = "workload.threads must be 1..16";
        else if (wt == "mem" && j.workload.value("mb", 100) < 1) *err = "workload.mb must be at least 1";
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
    explicit Master(Policy policy) {
        SchedulerConfig c;
        c.policy = policy;
        c.prod_min_priority = kProdMin;
        c.w_spread = 0.5;   // live cell: prefer spreading a job's tasks across machines
        c.w_package = 1.0;  // and machines that already have its package
        sched_.set_config(c);
    }

    void serve(int port, const std::string& ui_dir, const std::string& results_dir) {
        std::thread([this] { scheduler_loop(); }).detach();
        std::thread([this] { poll_loop(); }).detach();

        httplib::Server svr;
        svr.new_task_queue = [] { return new httplib::ThreadPool(8); };
        if (!svr.set_mount_point("/", ui_dir)) std::cerr << "warning: UI dir " << ui_dir << " not found\n";
        if (std::filesystem::exists(results_dir)) svr.set_mount_point("/results", results_dir);

        auto reply = [](httplib::Response& res, const json& j, int status = 200) {
            res.status = status;
            res.set_content(j.dump(), "application/json");
        };
        auto body_of = [](const httplib::Request& req) {
            auto b = json::parse(req.body.empty() ? "{}" : req.body, nullptr, false);
            return b.is_object() ? b : json();
        };

        svr.Get("/api/state", [&](const httplib::Request&, httplib::Response& res) { reply(res, state_json()); });
        svr.Get("/api/events", [&](const httplib::Request& req, httplib::Response& res) {
            uint64_t since = 0;
            try {
                if (req.has_param("since")) since = std::stoull(req.get_param_value("since"));
            } catch (const std::exception&) {
            }
            reply(res, events_json(since));
        });
        svr.Post("/api/jobs", [&](const httplib::Request& req, httplib::Response& res) {
            std::string err;
            json b = body_of(req);
            JobId id = b.is_object() ? submit(b, &err) : (err = "invalid JSON", 0);
            if (id) reply(res, {{"id", id}});
            else reply(res, {{"error", err}}, 400);
        });
        svr.Patch(R"(/api/jobs/(\d+))", [&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json b = body_of(req);
            json out = b.is_object() ? edit_job(std::stoll(req.matches[1].str()), b, &status)
                                     : (status = 400, json{{"error", "invalid JSON"}});
            reply(res, out, status);
        });
        svr.Post(R"(/api/jobs/(\d+)/reschedule)", [&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            json b = body_of(req);
            json out = b.is_object() ? reschedule_job(std::stoll(req.matches[1].str()), b, &status)
                                     : (status = 400, json{{"error", "invalid JSON"}});
            reply(res, out, status);
        });
        svr.Delete(R"(/api/jobs/(\d+))", [&](const httplib::Request& req, httplib::Response& res) {
            int status = 200;
            bool purge = req.has_param("purge") && req.get_param_value("purge") != "0";
            json out = delete_job(std::stoll(req.matches[1].str()), purge, &status);
            reply(res, out, status);
        });
        svr.Post("/api/config", [&](const httplib::Request& req, httplib::Response& res) {
            json b = body_of(req);
            Policy p;
            if (!b.is_object() || !b.contains("policy") || !b["policy"].is_string() ||
                !parse_policy(b["policy"].get<std::string>(), &p)) {
                reply(res, {{"error", "policy must be worst_fit, best_fit or hybrid"}}, 400);
                return;
            }
            std::lock_guard<std::mutex> g(mu_);
            SchedulerConfig c = sched_.config();
            c.policy = p;
            sched_.set_config(c);
            event("config", std::string("scoring policy set to ") + policy_name(p));
            reply(res, {{"ok", true}});
        });
        svr.Post(R"(/api/machines/(\d+)/fail)", [&](const httplib::Request& req, httplib::Response& res) {
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
        });
        svr.Post("/api/register", [&](const httplib::Request& req, httplib::Response& res) {
            json b = body_of(req);
            if (!b.is_object() || !b.contains("name") || !b.contains("address")) {
                reply(res, {{"error", "bad registration"}}, 400);
                return;
            }
            register_machine(b);
            reply(res, {{"ok", true}});
        });

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
    }

    Action kill_action(MachineId m, TaskId id) const { return {Action::Kill, m, minfo_[m].address, id, 0, json()}; }

    // Puts a placed task back in the pending queue (machine failure, preemption, restart).
    void requeue(TaskId id, const std::string& reason) {
        if (cell_.has_task(id)) cell_.unplace(id);
        TaskInfo& t = tinfo_.at(id);
        t.started = 0;
        set_state(t, "pending", reason);
    }

    void finish(TaskId id, const std::string& state, const std::string& reason) {
        cell_.remove_task(id);
        held_.erase(id);
        TaskInfo& t = tinfo_.at(id);
        t.ended = now_s();
        set_state(t, state, reason);
    }

    Task make_task(const JobInfo& j, int index, TaskId id = -1) const {
        Task t;
        t.id = id;
        t.job = j.id;
        t.index = index;
        t.user = j.user;
        t.priority = j.priority;
        t.limit = {j.cpu, static_cast<double>(j.ram_mb)};
        t.reservation = t.limit;
        t.constraints = j.constraints;
        t.distinct_machines = j.distinct;
        t.package = j.name;
        return t;
    }

    // Creates task `index` of job `j`: pending now, or held until `release` (> now).
    void add_task(JobInfo& j, int index, double release) {
        TaskInfo ti;
        ti.job = j.id;
        ti.index = index;
        ti.since = now_s();
        if (release > now_s()) {
            ti.id = cell_.reserve_id();
            held_[ti.id] = {release, make_task(j, index, ti.id)};
            ti.state = "waiting";
            ti.reason = "scheduled start";
        } else {
            ti.id = cell_.add_task(make_task(j, index));
            ti.reason = "waiting for the scheduler";
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
        if (release > now_s()) {
            held_[id] = {release, fresh};
            set_state(t, "waiting", why);
        } else {
            cell_.add_task(fresh);
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

    void register_machine(const json& b) {
        std::lock_guard<std::mutex> g(mu_);
        std::string name = b.value("name", "");
        Resources cap{b.value("cpu", 1.0), b.value("ram", 512.0)};
        std::map<std::string, std::string> attrs;
        if (b.contains("attributes") && b["attributes"].is_object())
            for (auto& [k, v] : b["attributes"].items()) attrs[k] = v.is_string() ? v.get<std::string>() : v.dump();
        for (auto& m : cell_.machines()) {
            if (m.name != name) continue;
            minfo_[m.id].address = b.value("address", "");
            m.capacity = cap;
            m.attributes = attrs;
            m.version++;
            return;  // the poller marks it up again on the next successful poll
        }
        cell_.add_machine(name, cap, attrs);
        MachineInfo mi;
        mi.address = b.value("address", "");
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

        std::lock_guard<std::mutex> g(mu_);
        for (const auto& [id, other] : jobs_) {
            if (other.name == j.name) {
                *err = "a job named '" + j.name + "' already exists: pick another name, or edit or reschedule it";
                return 0;
            }
        }
        j.id = next_job_++;
        j.submitted = now_s();
        j.start_at = start;
        for (int i = 0; i < j.task_count; ++i) add_task(j, i, start);
        event("job", "submitted " + j.name + " (" + std::to_string(j.task_count) + " x " + fmt(j.cpu) + " cpu / " +
                         std::to_string(j.ram_mb) + " MB, priority " + std::to_string(j.priority) + " " +
                         band(j.priority) + ", " + j.type + ")" +
                         (start > 0 ? ", starts " + in_words(start - now_s()) : ""));
        JobId id = j.id;
        jobs_[id] = std::move(j);
        wake_.notify_all();
        return id;
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
            auto same_constraints = [](const std::vector<Constraint>& a, const std::vector<Constraint>& c) {
                if (a.size() != c.size()) return false;
                for (size_t i = 0; i < a.size(); ++i)
                    if (a[i].key != c[i].key || a[i].value != c[i].value || a[i].hard != c[i].hard) return false;
                return true;
            };
            // Resources, binary (workload) or constraints changed: tasks must restart (§2.3).
            bool respec = nj.cpu != j.cpu || nj.ram_mb != j.ram_mb || nj.workload != j.workload ||
                          nj.distinct != j.distinct || !same_constraints(nj.constraints, j.constraints);
            bool inplace = nj.priority != j.priority || nj.user != j.user;
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
            if (nj.workload != j.workload) changes.push_back("workload");
            if (nj.type != j.type) changes.push_back("type " + j.type + " -> " + nj.type);
            if (nj.user != j.user) changes.push_back("user " + j.user + " -> " + nj.user);
            if (nj.distinct != j.distinct || !same_constraints(nj.constraints, j.constraints))
                changes.push_back("placement constraints");
            nj.tasks = j.tasks;
            j = nj;

            int restarted = 0, in_place = 0, added = 0, removed = 0;
            if (!done(before)) {
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
                    if (terminal(tinfo_.at(t).state)) continue;
                    if (respec) {
                        restart_task(j, t, -1, "restarting with the updated spec", actions);
                        restarted++;
                    } else if (inplace) {
                        update_in_place(j, t);
                        in_place++;
                    }
                }
                double release = before == "waiting" ? j.start_at : 0;
                for (int i = old_count; i < j.task_count; ++i, ++added) add_task(j, i, release);
            }
            std::string what = changes.empty() ? "no changes" : changes[0];
            for (size_t i = 1; i < changes.size(); ++i) what += ", " + changes[i];
            std::string effect = done(before) ? "takes effect on the next reschedule"
                                 : restarted   ? std::to_string(restarted) + " task(s) restarting"
                                 : in_place    ? "applied in place, no restarts"
                                               : "applied";
            event("job", "updated " + j.name + ": " + what + " (" + effect + ")");
            out = {{"ok", true},           {"restarted", restarted}, {"in_place", in_place},
                   {"added", added},       {"removed", removed},     {"status", job_status(j)},
                   {"changes", changes},   {"effect", effect}};
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
                double now = now_s();
                for (auto it = held_.begin(); it != held_.end();) {
                    if (it->second.release > now) {
                        ++it;
                        continue;
                    }
                    cell_.add_task(it->second.task);
                    auto ti = tinfo_.find(it->first);
                    if (ti != tinfo_.end() && ti->second.state == "waiting")
                        set_state(ti->second, "pending", "released at its scheduled start");
                    it = held_.erase(it);
                }
                if (cell_.pending_count() == 0) continue;
                ScheduleResult r = sched_.schedule(cell_);
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
                    set_state(t, "starting", "placed on " + machine_name(p.machine) + " (" +
                                                 policy_name(sched_.config().policy) + ")");
                    json body = {{"id", t.id},      {"attempt", t.attempt}, {"job", j.name},
                                 {"package", j.name}, {"cpu", j.cpu},       {"ram_mb", j.ram_mb},
                                 {"workload", j.workload}};
                    actions.push_back({Action::Start, p.machine, minfo_[p.machine].address, t.id, t.attempt, body});
                    event("schedule", task_name(t.id) + " -> " + machine_name(p.machine));
                }
                for (TaskId id : cell_.pending()) {
                    TaskInfo& t = tinfo_.at(id);
                    if (t.reason.rfind("preempted", 0) == 0 || t.reason.rfind("lost", 0) == 0 ||
                        t.reason.rfind("restart", 0) == 0)
                        continue;  // keep the more informative reason
                    t.reason = no_fit_reason(cell_.task(id));
                }
            }
            run_actions(actions);
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

    // ---- Borglet polling ---------------------------------------------------------------------

    void poll_loop() {
        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            std::vector<std::pair<MachineId, std::string>> targets;
            {
                std::lock_guard<std::mutex> g(mu_);
                for (size_t i = 0; i < minfo_.size(); ++i) targets.push_back({static_cast<MachineId>(i), minfo_[i].address});
            }
            // Poll all Borglets in parallel so one dead machine does not slow the others.
            std::vector<std::thread> threads;
            std::vector<std::pair<MachineId, json>> results(targets.size());
            for (size_t i = 0; i < targets.size(); ++i) {
                threads.emplace_back([&, i] {
                    httplib::Client cli(targets[i].second);
                    cli.set_connection_timeout(0, 700000);
                    cli.set_read_timeout(1, 0);
                    auto r = cli.Get("/status");
                    json j = (r && r->status == 200) ? json::parse(r->body, nullptr, false) : json();
                    results[i] = {targets[i].first, j.is_discarded() ? json() : j};
                });
            }
            for (auto& t : threads) t.join();

            std::vector<Action> actions;
            {
                std::lock_guard<std::mutex> g(mu_);
                for (auto& [m, j] : results) {
                    if (j.is_object()) on_status(m, j, actions);
                    else on_missed_poll(m);
                }
            }
            run_actions(actions);
        }
    }

    void on_missed_poll(MachineId m) {
        MachineInfo& mi = minfo_[m];
        if (++mi.misses < kMissesForDown || mi.status == "down") return;
        mi.status = "down";
        mi.cpu_usage = mi.mem_mb = 0;
        cell_.set_machine_up(m, false);
        int moved = 0;
        for (auto& [id, t] : tinfo_) {
            if (t.machine == m && placed(t.state)) {
                requeue(id, "lost: " + machine_name(m) + " went down");
                moved++;
            }
        }
        event("machine", machine_name(m) + " is DOWN (missed " + std::to_string(kMissesForDown) + " polls); " +
                             std::to_string(moved) + " task(s) rescheduled");
        wake_.notify_all();
    }

    void on_status(MachineId m, const json& s, std::vector<Action>& actions) {
        MachineInfo& mi = minfo_[m];
        Machine& mach = cell_.machine(m);
        mi.misses = 0;
        mi.last_seen = now_s();
        mi.cgroups = s.value("cgroups", false);
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
                    set_state(t, st, detail);
                    if (st == "running") event("task", task_name(id) + " running on " + mach.name);
                }
                t.cpu_usage = r.value("cpu_usage", 0.0);
                t.mem_mb = r.value("mem_mb", 0.0);
            } else if (st == "finished") {
                finish(id, "finished", detail);
                event("task", task_name(id) + " finished on " + mach.name);
            } else if (st == "failed" || st == "oom" || st == "killed") {
                std::string what = st == "oom" ? "OOM-killed" : (st == "killed" ? "killed" : "failed");
                if (j.type == "service") {
                    // Restart with exponential backoff (1, 2, 4, ... 30 s) so a crash loop does not
                    // monopolize the scheduler: the task is held out of the cell until then.
                    t.restarts++;
                    t.started = 0;
                    double delay = std::min(30.0, std::pow(2.0, std::min(t.restarts, 6) - 1));
                    Task copy = cell_.task(id);
                    cell_.remove_task(id);
                    copy.machine = -1;
                    held_[id] = {now_s() + delay, copy};
                    set_state(t, "pending", "restart #" + std::to_string(t.restarts) + " in " + fmt(delay, 0) +
                                                "s (backoff) after " + what + ": " + detail);
                    event(st == "oom" ? "oom" : "task", task_name(id) + " " + what + " on " + mach.name + " (" + detail +
                                                            "); restarting in " + fmt(delay, 0) + "s");
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
            for (TaskId t : m.tasks) tasks.push_back(t);
            machines.push_back({{"id", m.id},
                                {"name", m.name},
                                {"address", mi.address},
                                {"status", mi.status},
                                {"cgroups", mi.cgroups},
                                {"last_seen", mi.last_seen},
                                {"capacity", {{"cpu", m.capacity.cpu}, {"ram", m.capacity.ram}}},
                                {"allocated", {{"cpu", alloc.cpu}, {"ram", alloc.ram}}},
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
            tasks.push_back({{"id", id},
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
                             {"cpu", j.cpu},
                             {"ram_mb", j.ram_mb},
                             {"cpu_usage", t.cpu_usage},
                             {"mem_mb", t.mem_mb},
                             {"since", t.since},
                             {"started", t.started},
                             {"ended", t.ended},
                             {"release", h != held_.end() ? h->second.release : 0.0}});
        }
        return {{"time", now_s()},
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
};

}  // namespace

int main(int argc, char** argv) {
    ::signal(SIGPIPE, SIG_IGN);
    int port = 8080;
    std::string ui = "ui", results = "results";
    Policy policy = Policy::Hybrid;
    for (int i = 1; i + 1 < argc; i += 2) {
        std::string a = argv[i], v = argv[i + 1];
        if (a == "--port") port = std::stoi(v);
        else if (a == "--ui") ui = v;
        else if (a == "--results") results = v;
        else if (a == "--policy" && !parse_policy(v, &policy)) {
            std::cerr << "unknown policy " << v << "\n";
            return 2;
        }
    }
    Master master(policy);
    master.serve(port, ui, results);
    return 0;
}
