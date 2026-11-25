#!/usr/bin/env python3
"""End-to-end test of the live mini cell, driven through the Borgmaster's REST API.

    docker compose up -d --build
    python3 tests/e2e_cell.py [http://localhost:8080] [section ...]

Sections: lifecycle names_and_health quota after_and_overrides rolling_update
maintenance_and_crash_pairs fair_turns reclamation allocs placement (the last one also covers
preemption, isolation and machine failure). With no section named, everything runs.

The master_restart section needs a way to restart the Borgmaster: it runs only when the
environment variable BORG_RESTART_CMD holds a shell command that does so, for example
    BORG_RESTART_CMD="docker compose restart borgmaster" python3 tests/e2e_cell.py

The master_failover section is for a cell with several Borgmaster replicas. Point the test at
a replica that is NOT the elected master, and put a command that kills the elected one in
BORG_KILL_ELECTED_CMD.

It removes every job in the cell first, so don't run it against a cell you care about.
Checks: the job lifecycle API (delayed start, edit in place vs rolling update, scaling, rerun,
purge), ports, task names and health checks, quota and admission control, jobs that wait for
another job, per-task overrides, rolling updates with a disruption limit and undo, crash pairs,
machine maintenance (drain), fair turns between users, resource reclamation and evictions when
a machine runs out of memory, allocs (tasks of two jobs sharing a reserved slice of a machine), spreading, filling the cell, preemption
(only lower-priority tasks), cgroup OOM kills and CPU throttling, machine failure ->
rate-limited rescheduling -> recovery.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
ONLY = sys.argv[2:]
failures = 0


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read() or b"{}")


def state():
    return call("GET", "/api/state")


def events(since=0):
    return call("GET", f"/api/events?since={since}")["events"]


def last_event():
    return call("GET", f"/api/events?since={2**62}")["last"]


def submit(name, priority, tasks, cpu, ram_mb, workload, type_="service", distinct=False, **extra):
    job = {"name": name, "user": "e2e", "type": type_, "priority": priority, "tasks": tasks,
           "cpu": cpu, "ram_mb": ram_mb, "workload": workload, "distinct": distinct, **extra}
    return call("POST", "/api/jobs", job)["id"]


def remove_all_jobs():
    for _ in range(2):  # twice: an alloc set can only go after the jobs that run in it
        for j in state()["jobs"]:
            try:
                call("DELETE", f"/api/jobs/{j['id']}?purge=1")
            except urllib.error.HTTPError:
                pass


def reset():
    """Removes every job and quota and puts every machine back in service."""
    remove_all_jobs()
    call("POST", "/api/config", {"reclamation": False})
    for q in call("GET", "/api/quota")["quotas"]:
        call("POST", "/api/quota", {"user": q["user"], "band": q["band"], "remove": True})
    for m in state()["machines"]:
        if m["drain"]:
            call("POST", f"/api/machines/{m['id']}/undrain", {})


def rejected(method, path, body, code, text):
    """True if the call fails with HTTP `code` and an error message containing `text`."""
    try:
        call(method, path, body)
    except urllib.error.HTTPError as e:
        return e.code == code and text in e.read().decode()
    return False


def check(cond, desc):
    global failures
    print(f"  {'ok  ' if cond else 'FAIL'} {desc}")
    failures += not cond


def wait_for(desc, pred, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = state()
        if pred(s):
            print(f"  ok   {desc} ({time.time() - t0:.1f}s)")
            return s
        time.sleep(0.5)
    print(f"  FAIL {desc} (timed out after {timeout}s)")
    remove_all_jobs()
    sys.exit(1)


def tasks_of(s, name):
    return [t for t in s["tasks"] if t["job_name"] == name]


def running(s, name):
    return [t for t in tasks_of(s, name) if t["state"] == "running"]


def job(s, jid):
    return next((j for j in s["jobs"] if j["id"] == jid), None)


def machine(s, mid):
    return next(m for m in s["machines"] if m["id"] == mid)


def lifecycle():
    print("job lifecycle")
    jid = submit("e2e-later", 200, 2, 0.1, 32, {"type": "service"}, delay=4)
    s = state()
    check(job(s, jid)["status"] == "waiting" and all(t["state"] == "waiting" for t in tasks_of(s, "e2e-later")),
          "a delayed job waits for its start time")
    s = wait_for("it starts on time", lambda s: job(s, jid)["status"] == "running" and len(running(s, "e2e-later")) == 2,
                 timeout=20)
    before = {t["id"]: (t["machine"], t["attempt"]) for t in running(s, "e2e-later")}

    r = call("PATCH", f"/api/jobs/{jid}", {"priority": 210})
    check(r["in_place"] == 2 and r["restarted"] == 0, "a priority edit applies in place")
    after = {t["id"]: (t["machine"], t["attempt"]) for t in running(state(), "e2e-later")}
    check(after == before, "...and the tasks keep their machines and attempts")

    r = call("PATCH", f"/api/jobs/{jid}", {"cpu": 0.15})
    check(r["rolling"] and r["to_restart"] == 2 and r["restarted"] == 1,
          "a resource edit starts a rolling update: one task restarts first")
    most_down = [0]

    def rolled(s):
        most_down[0] = max(most_down[0], sum(t["state"] != "running" for t in tasks_of(s, "e2e-later")))
        return (len(running(s, "e2e-later")) == 2
                and all(t["attempt"] > before[t["id"]][1] and t["cpu"] == 0.15 for t in running(s, "e2e-later")))

    wait_for("both tasks end up restarted with the new spec", rolled)
    check(most_down[0] <= 1, f"...and never more than one of them was down at once (saw {most_down[0]})")

    r = call("PATCH", f"/api/jobs/{jid}", {"tasks": 1})
    check(r["removed"] == 1 and len(tasks_of(state(), "e2e-later")) == 1, "scaling down removes a task")

    try:
        submit("e2e-later", 100, 1, 0.1, 32, {"type": "service"})
        check(False, "duplicate job names are rejected")
    except urllib.error.HTTPError as e:
        check(e.code == 400 and "already exists" in e.read().decode(), "duplicate job names are rejected clearly")

    bid = submit("e2e-short", 100, 1, 0.1, 32, {"type": "sleep", "duration": 2}, type_="batch")
    wait_for("a short batch job completes", lambda s: job(s, bid)["status"] == "completed", timeout=25)
    r = call("POST", f"/api/jobs/{bid}/reschedule", {})
    check(r["action"] == "rerun", "rescheduling a finished job runs it again")
    wait_for("the second run completes",
             lambda s: job(s, bid)["runs"] == 2 and job(s, bid)["status"] == "completed", timeout=25)

    call("DELETE", f"/api/jobs/{jid}?purge=1")
    check(job(state(), jid) is None, "purge kills and removes a live job")
    remove_all_jobs()


def names_and_health():
    print("ports, names and health checks")
    wid = submit("e2e-srv", 200, 2, 0.1, 32, {"type": "service"})
    s = wait_for("2 server tasks run", lambda s: len(running(s, "e2e-srv")) == 2)
    tasks = running(s, "e2e-srv")
    check(all(len(t["ports"]) == 1 for t in tasks), "each server task was given one port")
    check(len({(t["machine"], t["ports"][0]) for t in tasks}) == 2, "no two tasks share a port on a machine")
    names = wait_for_names("both names are in the name service and healthy", "e2e-srv",
                           lambda ns: len(ns) == 2 and all(n["healthy"] for n in ns))
    check(sorted(n["name"] for n in names) == ["0.e2e-srv.e2e.cc", "1.e2e-srv.e2e.cc"],
          "names look like <index>.<job>.<user>.<cell>")

    submit("e2e-client", 100, 1, 0.1, 32, {"type": "client", "target": "e2e-srv", "rps": 5}, type_="batch")

    def client_ok(s):
        notes = [t["note"] for t in running(s, "e2e-client")]
        return notes and notes[0].startswith("ok ") and int(notes[0].split()[1]) >= 5

    wait_for("a client task finds the servers by name and calls them", client_ok)

    victim = tasks[0]
    call("POST", f"/api/jobs/{wid}/poke", {"action": "sick", "index": victim["index"]})
    wait_for("a task whose health check fails is stopped and restarted",
             lambda s: any(t["id"] == victim["id"] and t["restarts"] >= 1 for t in s["tasks"]), timeout=30)
    wait_for_names("it comes back healthy under the same name", "e2e-srv",
                   lambda ns: len(ns) == 2 and all(n["healthy"] for n in ns), timeout=30)
    note = running(state(), "e2e-client")[0]["note"]
    ok, failed = int(note.split()[1]), int(note.split()[4])
    check(ok > 20 and failed <= 6, f"the client kept working meanwhile ({note.split(' · last')[0]})")
    remove_all_jobs()


def wait_for_names(desc, job_name, pred, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        names = call("GET", f"/api/bns?job={job_name}")["names"]
        if pred(names):
            print(f"  ok   {desc} ({time.time() - t0:.1f}s)")
            return names
        time.sleep(0.5)
    print(f"  FAIL {desc} (timed out after {timeout}s)")
    remove_all_jobs()
    sys.exit(1)


def quota():
    print("quota and admission control")
    call("POST", "/api/quota", {"user": "ann", "band": "production", "cpu": 0.5, "ram_mb": 256})
    job = {"name": "e2e-q1", "user": "ann", "type": "service", "priority": 200, "tasks": 4, "cpu": 0.25,
           "ram_mb": 32, "workload": {"type": "service"}}
    check(rejected("POST", "/api/jobs", job, 403, "rejected by admission control"),
          "a job over its user's quota is rejected at submission")
    check(not any(j["name"] == "e2e-q1" for j in state()["jobs"]), "...and never enters the queue")
    job["tasks"] = 2
    jid = call("POST", "/api/jobs", job)["id"]
    check(jid > 0, "a job that fits the quota is admitted")
    check(rejected("PATCH", f"/api/jobs/{jid}", {"tasks": 3}, 403, "rejected by admission control"),
          "growing it past the quota is rejected too")
    job.update(name="e2e-q2", priority=50, tasks=8)
    check(call("POST", "/api/jobs", job)["id"] > 0, "the free band needs no quota")
    job.update(name="e2e-q3", user="bob", priority=200, tasks=4)
    check(call("POST", "/api/jobs", job)["id"] > 0, "users without a quota are not limited")
    cap = state()["capacity"]["cpu"]
    check(rejected("POST", "/api/quota", {"user": "bob", "band": "production", "cpu": cap}, 400, "oversold"),
          "prod quota cannot be oversold beyond the cell's capacity")
    used = next(q for q in call("GET", "/api/quota")["quotas"] if q["user"] == "ann")["used"]
    check(abs(used["cpu"] - 0.5) < 1e-6, "quota usage counts what the user's live jobs ask for")
    reset()


def after_and_overrides():
    print("job dependencies and per-task overrides")
    a = submit("e2e-first", 100, 1, 0.1, 32, {"type": "sleep", "duration": 4}, type_="batch")
    b = submit("e2e-second", 100, 2, 0.1, 32, {"type": "sleep", "duration": 30}, type_="batch", after="e2e-first",
               overrides={"1": {"cpu": 0.3, "workload": {"duration": 60}}})
    s = wait_for("the first job runs while the second waits for it",
                 lambda s: job(s, a)["status"] == "running" and job(s, b)["status"] == "waiting")
    check(all("e2e-first" in t["reason"] for t in tasks_of(s, "e2e-second")), "the waiting tasks say what they wait for")
    wait_for("the second job starts once the first has finished",
             lambda s: job(s, a)["status"] == "completed" and len(running(s, "e2e-second")) == 2, timeout=30)
    by_index = {t["index"]: t for t in tasks_of(state(), "e2e-second")}
    check(by_index[0]["cpu"] == 0.1 and by_index[1]["cpu"] == 0.3, "task 1 runs with its own overridden CPU request")
    check(rejected("POST", "/api/jobs", {"name": "e2e-third", "after": "nope"}, 400, "no job named"),
          "a job cannot wait for a job that does not exist")
    check(rejected("POST", "/api/jobs", {"name": "e2e-third", "after": "e2e-second", "delay": 30}, 400, "not both"),
          "a job cannot both wait for a job and have a start delay")
    remove_all_jobs()


def rolling_update():
    print("rolling updates")
    jid = submit("e2e-roll", 200, 3, 0.1, 32, {"type": "service"})
    s = wait_for("3 tasks run", lambda s: len(running(s, "e2e-roll")) == 3)
    first = {t["id"]: t["attempt"] for t in tasks_of(s, "e2e-roll")}
    r = call("PATCH", f"/api/jobs/{jid}", {"ram_mb": 48, "rolling": {"max_unavailable": 1, "max_disruptions": 1}})
    check(r["restarted"] == 1 and r["undoable"], "with a disruption limit of 1, one task is restarted")
    s = wait_for("the update stops there: 1 task on the new spec, 2 skipped",
                 lambda s: len(running(s, "e2e-roll")) == 3 and job(s, jid)["update"]["skipped"] == 2
                 and not job(s, jid)["update"]["rolling"])
    check(sorted(t["ram_mb"] for t in tasks_of(s, "e2e-roll")) == [48, 48, 48]
          and sum(t["outdated"] for t in tasks_of(s, "e2e-roll")) == 2,
          "the skipped tasks keep running the old spec")
    r = call("POST", f"/api/jobs/{jid}/update", {"action": "undo"})
    check(r["action"] == "undone" and r["to_restart"] == 1, "undo rolls back only the task that was updated")
    s = wait_for("after the undo every task runs the old spec again",
                 lambda s: len(running(s, "e2e-roll")) == 3 and not any(t["outdated"] for t in tasks_of(s, "e2e-roll"))
                 and all(t["ram_mb"] == 32 for t in tasks_of(s, "e2e-roll")))
    untouched = sum(t["attempt"] == first[t["id"]] for t in tasks_of(s, "e2e-roll"))
    check(untouched == 2, f"the two skipped tasks were never restarted (untouched: {untouched})")
    check(rejected("POST", f"/api/jobs/{jid}/update", {"action": "undo"}, 400, "no open update"),
          "an update can be undone only once")
    r = call("PATCH", f"/api/jobs/{jid}", {"ports": 1, "health": True, "appclass": "ls", "cpu": 0.1})
    check(r["to_restart"] == 0 and not r["rolling"], "sending back the settings a job already has restarts nothing")
    r = call("PATCH", f"/api/jobs/{jid}", {"overrides": {"2": {"cpu": 0.2}}})
    check(r["to_restart"] == 1, "a change for one task restarts only that task")
    s = wait_for("that task comes back with its own CPU request, the others untouched",
                 lambda s: len(running(s, "e2e-roll")) == 3 and not job(s, jid)["update"]["rolling"])
    by_index = {t["index"]: t for t in tasks_of(s, "e2e-roll")}
    check(by_index[2]["cpu"] == 0.2 and by_index[0]["cpu"] == 0.1, "task 2 now asks for more CPU than the others")
    remove_all_jobs()


def maintenance_and_crash_pairs():
    print("machine maintenance and crash pairs")
    s = state()
    ids = [m["id"] for m in s["machines"]]
    keep, others = ids[0], ids[1:]
    keep_name = machine(s, keep)["name"]
    for m in others:
        call("POST", f"/api/machines/{m}/drain", {})
    wait_for("empty machines drain at once", lambda s: all(machine(s, m)["drain"] == "drained" for m in others))
    jid = submit("e2e-picky", 200, 1, 0.1, 32, {"type": "service", "crash_on": keep_name})
    wait_for(f"a task lands on the only machine in service ({keep_name}) and crashes there",
             lambda s: any(t["restarts"] >= 1 and keep_name in t["avoid"] for t in tasks_of(s, "e2e-picky")), timeout=30)
    s = state()
    check(not running(s, "e2e-picky"), "it is not placed on that machine again, and draining machines take no tasks")
    for m in others:
        call("POST", f"/api/machines/{m}/undrain", {})
    wait_for("back in service, another machine runs it",
             lambda s: any(t["machine"] != keep for t in running(s, "e2e-picky")), timeout=40)
    remove_all_jobs()

    submit("e2e-web", 200, 3, 0.1, 32, {"type": "service"}, distinct=True)
    s = wait_for("3 tasks run on 3 machines", lambda s: len(running(s, "e2e-web")) == 3)
    target = running(s, "e2e-web")[0]["machine"]
    submit("e2e-fill", 100, 2, 0.1, 32, {"type": "sleep", "duration": 300}, type_="batch",
           constraints=[{"key": "rack", "value": machine(s, target)["attributes"]["rack"], "hard": False}])
    wait_for("2 batch tasks run too", lambda s: len(running(s, "e2e-fill")) == 2)
    mark = last_event()
    call("POST", f"/api/machines/{target}/drain", {"max_down": 1})
    most_down = [0]

    def drained(s):
        most_down[0] = max(most_down[0], sum(t["state"] != "running" for t in tasks_of(s, "e2e-web")))
        return machine(s, target)["drain"] == "drained" and len(running(s, "e2e-web")) == 3

    s = wait_for("draining a machine moves its tasks away", drained, timeout=40)
    check(all(t["machine"] != target for t in s["tasks"] if t["state"] == "running"), "nothing runs on it any more")
    check(most_down[0] <= 1, f"at most one task of the job was down at a time (saw {most_down[0]})")
    moved = [e for e in events(mark) if e["kind"] == "drain"]
    check(len(moved) >= 1, f"the moves are in the event log ({len(moved)})")
    call("POST", f"/api/machines/{target}/undrain", {})
    check(machine(state(), target)["drain"] == "", "undrain puts the machine back in service")
    remove_all_jobs()


def fair_turns():
    print("fair turns between users")
    s = state()
    small = min(s["machines"], key=lambda m: (m["capacity"]["cpu"], -m["id"]))  # a 1-CPU machine in its own rack
    rack = small["attributes"]["rack"]
    slots = int(sum(m["capacity"]["cpu"] for m in s["machines"] if m["attributes"]["rack"] == rack) / 0.25 + 1e-6)
    start = time.time() + 3  # both jobs enter the queue in the same scheduling pass
    only = [{"key": "rack", "value": rack, "hard": True}]
    for name, user in (("e2e-zed", "zed"), ("e2e-amy", "amy")):
        call("POST", "/api/jobs", {"name": name, "user": user, "type": "batch", "priority": 100, "tasks": slots,
                                   "cpu": 0.25, "ram_mb": 32, "workload": {"type": "sleep", "duration": 300},
                                   "constraints": only, "start_at": start})
    s = wait_for(f"two users compete for {slots} slots", lambda s: len(running(s, "e2e-zed")) + len(running(s, "e2e-amy")) == slots)
    amy, zed = len(running(s, "e2e-amy")), len(running(s, "e2e-zed"))
    check(abs(amy - zed) <= 1, f"each user gets half, whoever's name sorts first (amy {amy}, zed {zed})")
    remove_all_jobs()


def reclamation():
    print("resource reclamation")
    racks = {}
    for m in state()["machines"]:
        racks.setdefault(m["attributes"]["rack"], []).append(m)
    rack, mach = next((r, ms[0]) for r, ms in racks.items() if len(ms) == 1)  # a machine alone in its rack
    cpu, ram = mach["capacity"]["cpu"], mach["capacity"]["ram"]
    only = [{"key": "rack", "value": rack, "hard": True}]
    call("POST", "/api/config", {"reclamation": True, "reclaim_warmup": 3})
    big = submit("e2e-big", 200, 1, round(cpu * 0.9, 2), int(ram * 0.75), {"type": "service"}, constraints=only)
    wait_for(f"a prod task that asks for 90% of {mach['name']} runs there", lambda s: len(running(s, "e2e-big")) == 1)
    submit("e2e-fill", 100, 1, round(cpu * 0.5, 2), int(ram * 0.4), {"type": "mem", "mb": int(ram * 0.33), "duration": 300},
           type_="batch", constraints=only)
    time.sleep(1.5)
    check(not running(state(), "e2e-fill"), "a batch task that needs half the machine does not fit next to it at first")
    mark = last_event()
    s = wait_for("once the prod task's reservation has shrunk to what it really uses, the batch task runs in the rest",
                 lambda s: len(running(s, "e2e-fill")) == 1, timeout=45)
    m = machine(s, mach["id"])
    check(m["allocated"]["cpu"] > m["capacity"]["cpu"] and m["reserved"]["cpu"] < m["capacity"]["cpu"],
          f"the machine's tasks ask for more CPU than it has ({m['allocated']['cpu']:.2f} of {m['capacity']['cpu']:.2f}) "
          f"but reserve less ({m['reserved']['cpu']:.2f})")
    check(any(e["kind"] == "reclaim" for e in events(mark)), "the log says the task runs in reclaimed resources")
    before = tasks_of(s, "e2e-big")[0]
    wait_for("the batch task fills its memory",
             lambda s: running(s, "e2e-fill") and running(s, "e2e-fill")[0]["mem_mb"] > ram * 0.3)
    mark = last_event()
    call("POST", f"/api/jobs/{big}/poke", {"action": "mem", "mb": int(ram * 0.68), "seconds": 25})
    wait_for("when the prod task's memory use spikes, the machine evicts the batch task",
             lambda s: any(e["kind"] == "evict" for e in events(mark)), timeout=30)
    s = state()
    after, victim = tasks_of(s, "e2e-big")[0], tasks_of(s, "e2e-fill")[0]
    check(after["state"] == "running" and after["attempt"] == before["attempt"] and after["restarts"] == 0,
          "the prod task is never touched")
    check(victim["state"] == "pending" and victim["reason"].startswith("evicted"),
          "the evicted batch task is back in the queue, with the reason")
    call("POST", "/api/config", {"reclamation": False})
    remove_all_jobs()


def allocs():
    print("allocs")
    sid = call("POST", "/api/jobs", {"name": "e2e-pods", "user": "e2e", "type": "alloc", "priority": 200, "tasks": 2,
                                     "cpu": 0.5, "ram_mb": 192, "distinct": True})["id"]
    s = wait_for("an alloc set reserves 2 allocs on 2 machines",
                 lambda s: len(running(s, "e2e-pods")) == 2 and len({t["machine"] for t in running(s, "e2e-pods")}) == 2)
    home = {t["index"]: t["machine"] for t in running(s, "e2e-pods")}
    check(abs(machine(s, home[0])["allocated"]["cpu"] - 0.5) < 1e-6, "an empty alloc already holds its resources on the machine")
    submit("e2e-server", 200, 2, 0.2, 64, {"type": "service"}, alloc_set="e2e-pods")
    submit("e2e-saver", 200, 2, 0.1, 32, {"type": "logsaver"}, alloc_set="e2e-pods")
    inside = lambda s: tasks_of(s, "e2e-server") + tasks_of(s, "e2e-saver")
    s = wait_for("a server and a logsaver, from two jobs, run inside each alloc",
                 lambda s: len(running(s, "e2e-server")) == 2 and len(running(s, "e2e-saver")) == 2)
    check(all(t["machine"] == home[t["index"]] and t["alloc_name"] == f"e2e-pods/{t['index']}" for t in inside(s)),
          "task i of each job is in alloc i, on that alloc's machine")
    check(abs(machine(s, home[0])["allocated"]["cpu"] - 0.5) < 1e-6, "the tasks use the alloc's resources, not extra ones")
    submit("e2e-caller", 100, 1, 0.1, 32, {"type": "client", "target": "e2e-server", "rps": 5}, type_="batch")
    wait_for("the logsaver reads the server's request log through the alloc's shared directory",
             lambda s: any(t["note"].startswith("saved") and int(t["note"].split()[1]) > 0 for t in running(s, "e2e-saver")),
             timeout=30)
    fat = {"name": "e2e-fat", "user": "e2e", "type": "service", "priority": 200, "tasks": 1, "cpu": 0.9, "ram_mb": 64,
           "workload": {"type": "service"}, "alloc_set": "e2e-pods"}
    check(rejected("POST", "/api/jobs", fat, 400, "asks for more than one alloc"), "a task bigger than an alloc is rejected")
    submit("e2e-extra", 200, 1, 0.3, 32, {"type": "sleep", "duration": 60}, type_="batch", alloc_set="e2e-pods")
    wait_for("a task that does not fit in what is left of its alloc waits",
             lambda s: tasks_of(s, "e2e-extra") and "no room" in tasks_of(s, "e2e-extra")[0]["reason"])
    call("POST", f"/api/machines/{home[0]}/fail", {"seconds": 12})

    def moved(s):
        alloc = [t for t in running(s, "e2e-pods") if t["index"] == 0]
        return (alloc and alloc[0]["machine"] != home[0]
                and all(t["state"] == "running" and t["machine"] == alloc[0]["machine"] for t in inside(s) if t["index"] == 0))

    wait_for("when its machine fails, the alloc is reserved elsewhere and its tasks follow it there", moved, timeout=45)
    check(rejected("DELETE", f"/api/jobs/{sid}?purge=1", None, 409, "remove it first"),
          "an alloc set that still holds jobs cannot be removed")
    wait_for("the failed machine comes back", lambda s: machine(s, home[0])["status"] == "up", timeout=45)
    remove_all_jobs()
    check(not state()["jobs"], "once its jobs are gone, the alloc set can be removed")


def master_restart():
    cmd = os.environ.get("BORG_RESTART_CMD")
    if not cmd:
        print("master restart: skipped (set BORG_RESTART_CMD to a command that restarts the Borgmaster)")
        return
    print("master restart")
    if state()["master"]["replicas"]:
        print("  skipped: this cell has several Borgmaster replicas (see master_failover)")
        return
    if not state()["master"]["checkpoint"]["enabled"]:
        print("  skipped: this Borgmaster runs without --state, so it keeps no checkpoint")
        return
    call("POST", "/api/quota", {"user": "ann", "band": "production", "cpu": 2})
    submit("e2e-keep", 200, 3, 0.1, 32, {"type": "service"}, distinct=True)
    submit("e2e-later", 100, 1, 0.1, 32, {"type": "sleep", "duration": 30}, type_="batch", delay=3600)
    s = wait_for("3 server tasks run and a delayed job waits",
                 lambda s: len(running(s, "e2e-keep")) == 3 and tasks_of(s, "e2e-later")[0]["state"] == "waiting")
    before = {t["id"]: (t["machine"], t["attempt"], t["started"], tuple(t["ports"])) for t in running(s, "e2e-keep")}
    release = tasks_of(s, "e2e-later")[0]["release"]
    seen = last_event()
    time.sleep(1.5)  # the Borgmaster records changes within a second
    subprocess.run(cmd, shell=True, check=True)

    def back(_):
        try:
            return state()["master"]["checkpoint"]["restored_at"] > 0
        except Exception:
            return False

    t0 = time.time()
    while not back(None):
        if time.time() - t0 > 40:
            print("  FAIL the Borgmaster comes back (timed out)")
            sys.exit(1)
        time.sleep(0.5)
    print(f"  ok   the Borgmaster comes back and restores its state ({time.time() - t0:.1f}s)")
    s = wait_for("every machine is up again", lambda s: all(m["status"] == "up" for m in s["machines"]), timeout=30)
    time.sleep(3)  # a few polls: anything it had forgotten would be killed or rescheduled by now
    s = state()
    after = {t["id"]: (t["machine"], t["attempt"], t["started"], tuple(t["ports"])) for t in running(s, "e2e-keep")}
    check(after == before, "its jobs are still there, and their tasks never stopped: same machines, attempts and ports")
    later = tasks_of(s, "e2e-later")
    check(later and later[0]["state"] == "waiting" and abs(later[0]["release"] - release) < 1e-3,
          "a delayed job still waits for the same start time")
    check(any(q["user"] == "ann" and q["cpu"] == 2 for q in call("GET", "/api/quota")["quotas"]), "quotas were kept")
    check(last_event() > seen and any("restored" in e["msg"] for e in events(seen)),
          "the event log was kept, and says the Borgmaster restarted")
    jid = submit("e2e-new", 200, 1, 0.1, 32, {"type": "service"})
    check(jid > max(j["id"] for j in s["jobs"]), "new jobs get fresh ids")
    wait_for("and the restored Borgmaster schedules new work", lambda s: len(running(s, "e2e-new")) == 1)
    reset()


def master_failover():
    cmd = os.environ.get("BORG_KILL_ELECTED_CMD")
    if not cmd:
        print("master failover: skipped (set BORG_KILL_ELECTED_CMD to a command that kills the elected master)")
        return
    print("master failover")
    me = call("GET", "/internal/replica")
    m = state()["master"]
    if len(m["replicas"]) < 2 or me["elected"]:
        print("  skipped: needs a cell with replicas, and a test pointed at one that is not the elected master")
        return
    old, election = m["name"], m["election"]
    check(len(m["shards"]) == len(m["replicas"]) and sum(len(x["machines"]) for x in m["shards"]) == len(state()["machines"]),
          f"each of the {len(m['replicas'])} replicas runs a link shard, and together they cover every machine")
    call("POST", "/api/quota", {"user": "ann", "band": "production", "cpu": 2})
    submit("e2e-keep", 200, 3, 0.1, 32, {"type": "service"}, distinct=True)
    submit("e2e-later", 100, 1, 0.1, 32, {"type": "sleep", "duration": 30}, type_="batch", delay=3600)
    s = wait_for(f"through a follower ({me['name']}): 3 server tasks run and a delayed job waits",
                 lambda s: len(running(s, "e2e-keep")) == 3 and tasks_of(s, "e2e-later")[0]["state"] == "waiting")
    before = {t["id"]: (t["machine"], t["attempt"], t["started"], tuple(t["ports"])) for t in running(s, "e2e-keep")}
    seen = last_event()
    time.sleep(1.5)
    subprocess.run(cmd, shell=True, check=True, stdout=subprocess.DEVNULL)
    t0 = time.time()
    while True:
        try:
            m = state()["master"]
            if m["name"] != old and m["election"] > election:
                break
        except Exception:
            pass
        if time.time() - t0 > 40:
            print("  FAIL another replica takes over (timed out)")
            sys.exit(1)
        time.sleep(0.25)
    print(f"  ok   {old} was killed: {m['name']} is elected and answers after {time.time() - t0:.1f}s")
    time.sleep(4)  # a few polls: anything the new master had wrong would be killed or rescheduled by now
    s = state()
    after = {t["id"]: (t["machine"], t["attempt"], t["started"], tuple(t["ports"])) for t in running(s, "e2e-keep")}
    check(after == before, "the tasks never stopped: same machines, attempts and ports")
    check(tasks_of(s, "e2e-later")[0]["state"] == "waiting", "the delayed job still waits")
    check(any(q["user"] == "ann" and q["cpu"] == 2 for q in call("GET", "/api/quota")["quotas"]), "quotas were kept")
    check(any("is now the elected master" in e["msg"] for e in events(seen)), "the event log was kept, and records the election")
    m = wait_for("the dead replica's Borglets are taken over by the other link shards",
                 lambda s: old not in [r["name"] for r in s["master"]["replicas"]]
                 and sum(len(x["machines"]) for x in s["master"]["shards"]) == len(s["machines"]), timeout=20)["master"]
    check(all(mm["status"] == "up" for mm in state()["machines"]), "every machine is still up")
    submit("e2e-new", 200, 1, 0.1, 32, {"type": "service"})
    wait_for("the new master schedules new work", lambda s: len(running(s, "e2e-new")) == 1)
    reset()


def main():
    print(f"e2e test against {BASE}")
    reset()
    s = wait_for("at least 3 machines up", lambda s: sum(m["status"] == "up" for m in s["machines"]) >= 3)
    cgroups = all(m["cgroups"] for m in s["machines"] if m["status"] == "up")

    for section in (lifecycle, names_and_health, quota, after_and_overrides, rolling_update,
                    maintenance_and_crash_pairs, fair_turns, reclamation, allocs, master_restart, master_failover):
        if not ONLY or section.__name__ in ONLY:
            section()
    if ONLY and "placement" not in ONLY:
        print("PASSED" if failures == 0 else f"FAILED ({failures} check(s))")
        return 1 if failures else 0

    print("placement")
    submit("e2e-web", 200, 3, 0.25, 64, {"type": "service"}, distinct=True)
    s = wait_for("3 prod tasks running on 3 different machines",
                 lambda s: len(running(s, "e2e-web")) == 3 and len({t["machine"] for t in running(s, "e2e-web")}) == 3)

    # Fill every remaining CPU slot with 0.25-core batch tasks (all machine sizes are multiples of 0.25).
    free = s["capacity"]["cpu"] - s["allocated"]["cpu"]
    n = int(free / 0.25 + 1e-6)
    # With cgroups the batch tasks busy-loop, so we can check that cpu.max throttles them.
    work = {"type": "cpu", "threads": 1, "duration": 600} if cgroups else {"type": "sleep", "duration": 600}
    submit("e2e-batch", 100, n, 0.25, 32, work, type_="batch")
    s = wait_for(f"{n} batch tasks fill the cell", lambda s: len(running(s, "e2e-batch")) == n)
    check(abs(s["allocated"]["cpu"] - s["capacity"]["cpu"]) < 1e-6, "cell CPU fully allocated")

    print("preemption")
    mark = last_event()  # the event log outlives jobs; only look at what this submission causes
    submit("e2e-prod", 250, 2, 0.5, 64, {"type": "service"}, distinct=True)
    s = wait_for("higher-priority job runs in a full cell", lambda s: len(running(s, "e2e-prod")) == 2)
    pre = [e for e in events(mark) if e["kind"] == "preempt" and "by e2e-prod" in e["msg"]]
    check(len(pre) == 4, f"exactly 4 batch tasks preempted to make room (got {len(pre)})")
    check(all(e["msg"].startswith("e2e-batch/") for e in pre), "only lower-priority tasks were preempted")
    check(all(t["state"] == "running" for t in tasks_of(s, "e2e-web")), "prod tasks were not preempted")
    victims = [t for t in tasks_of(s, "e2e-batch") if t["state"] == "pending"]
    check(len(victims) == 4 and all(t["reason"].startswith("preempted") for t in victims),
          "victims are back in the pending queue")

    if cgroups:
        print("isolation")
        submit("e2e-oom", 300, 1, 0.1, 32, {"type": "mem", "mb": 128, "duration": 60}, type_="batch")
        wait_for("task allocating 128 MB with a 32 MB limit is OOM-killed",
                 lambda s: any(t["state"] == "oom" for t in tasks_of(s, "e2e-oom")))
        s = wait_for("busy-looping batch tasks report CPU usage",
                     lambda s: running(s, "e2e-batch") and all(t["cpu_usage"] > 0.05 for t in running(s, "e2e-batch")))
        burners = running(s, "e2e-batch")
        top = max(t["cpu_usage"] for t in burners)
        avg = sum(t["cpu_usage"] for t in burners) / len(burners)
        check(top <= 0.25 * 1.15 + 0.02, f"cpu.max caps each 0.25-core busy loop (max {top:.2f} cores)")
        check(avg >= 0.2, f"busy loops get their full share (avg {avg:.2f} cores)")
    else:
        print("isolation: skipped (Borglets run without cgroups)")

    print("machine failure")
    s = state()
    task = running(s, "e2e-web")[0]
    mid, tid = task["machine"], task["id"]
    mark = last_event()
    call("POST", f"/api/machines/{mid}/fail", {"seconds": 15})
    wait_for(f"{machine(s, mid)['name']} marked DOWN after missed polls",
             lambda s: machine(s, mid)["status"] == "down", timeout=15)
    wait_for("its prod task is rescheduled onto another machine",
             lambda s: any(t["id"] == tid and t["state"] == "running" and t["machine"] != mid for t in s["tasks"]),
             timeout=20)
    down = [e for e in events(mark) if e["kind"] == "machine" and "is DOWN" in e["msg"]]
    check(down and "per second" in down[-1]["msg"], "tasks of the lost machine are re-queued at a limited rate")
    wait_for("machine comes back UP after the outage", lambda s: machine(s, mid)["status"] == "up", timeout=45)

    remove_all_jobs()
    print("PASSED" if failures == 0 else f"FAILED ({failures} check(s))")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
