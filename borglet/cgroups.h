// Minimal cgroup v2 manager: one cgroup per task (cpu.max, cpu.weight, memory.max), optionally
// nested inside the cgroup of an alloc (§2.4), plus a plain per-process fallback for usage
// numbers on systems without cgroup v2.
#pragma once

#include <sys/types.h>

#include <cstdint>
#include <string>

namespace borglet {

class Cgroups {
public:
    // Moves this process out of the root cgroup and enables the cpu+memory controllers for
    // children (cgroup v2 forbids processes in a cgroup that delegates controllers).
    // Returns false when cgroup v2 is missing or read-only; tasks then run without isolation.
    bool init(std::string* why);
    bool enabled() const { return enabled_; }

    struct Limits {
        double cpu_cores = 1;    // CPU limit
        int64_t ram_bytes = 0;   // memory limit
        int weight = 100;        // cpu.weight (1..10000): the share of CPU under contention (§6.2)
        bool cap_cpu = true;     // false: no hard CPU cap, the task may use idle CPU (slack)
    };
    // Creates <parent>/task-<name> with the given limits; returns its path ("" on failure).
    // `parent` is an alloc's cgroup, or "" for the root.
    std::string create(const std::string& name, const Limits& limits, const std::string& parent = "");
    // Creates <root>/alloc-<name>: a container for the cgroups of the tasks that share an alloc.
    std::string create_alloc(const std::string& name, double cpu_cores, int64_t ram_bytes);
    void remove(const std::string& path);

    struct Stats {
        uint64_t cpu_usec = 0;
        int64_t mem_bytes = 0;
        int oom_kills = 0;
    };
    bool stats(const std::string& path, Stats* out) const;
    // Fallback without cgroups: CPU time and resident memory of one process.
    static bool proc_stats(pid_t pid, Stats* out);

    // Async-signal-safe: moves the calling process into the cgroup. Used between fork and exec.
    static bool join(const char* procs_path);

private:
    std::string root_ = "/sys/fs/cgroup";
    bool enabled_ = false;
};

}  // namespace borglet
