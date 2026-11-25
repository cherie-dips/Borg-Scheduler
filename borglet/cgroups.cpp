#include "cgroups.h"

#include <fcntl.h>
#if defined(__APPLE__)
#include <libproc.h>
#include <mach/mach_time.h>
#endif
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <fstream>
#include <sstream>
#include <thread>

namespace borglet {

namespace {

bool write_file(const std::string& path, const std::string& value) {
    int fd = ::open(path.c_str(), O_WRONLY);
    if (fd < 0) return false;
    ssize_t n = ::write(fd, value.data(), value.size());
    ::close(fd);
    return n == static_cast<ssize_t>(value.size());
}

std::string read_file(const std::string& path) {
    std::ifstream f(path);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

}  // namespace

bool Cgroups::init(std::string* why) {
    std::string controllers = read_file(root_ + "/cgroup.controllers");
    if (controllers.empty()) {
        *why = "cgroup v2 not available (" + root_ + "/cgroup.controllers missing)";
        return false;
    }
    if (controllers.find("cpu") == std::string::npos || controllers.find("memory") == std::string::npos) {
        *why = "cpu/memory controllers not delegated: " + controllers;
        return false;
    }
    // Move every process in the root of our cgroup namespace into a leaf for the agent.
    std::string agent = root_ + "/borglet-agent";
    ::mkdir(agent.c_str(), 0755);
    std::istringstream procs(read_file(root_ + "/cgroup.procs"));
    std::string pid;
    while (std::getline(procs, pid))
        if (!pid.empty()) write_file(agent + "/cgroup.procs", pid);
    if (!write_file(root_ + "/cgroup.subtree_control", "+cpu +memory")) {
        *why = std::string("cannot enable +cpu +memory in subtree_control: ") + std::strerror(errno) +
               " (is the container privileged with a private cgroup namespace?)";
        return false;
    }
    enabled_ = true;
    return true;
}

namespace {

std::string cpu_max(double cores) {
    const long period = 100000;
    if (cores < 0) return "max " + std::to_string(period);
    long quota = std::max(1000L, static_cast<long>(std::lround(cores * period)));
    return std::to_string(quota) + " " + std::to_string(period);
}

}  // namespace

std::string Cgroups::create(const std::string& name, const Limits& limits, const std::string& parent) {
    if (!enabled_) return "";
    std::string path = (parent.empty() ? root_ : parent) + "/task-" + name;
    if (::mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) return "";
    write_file(path + "/cpu.max", cpu_max(limits.cap_cpu ? limits.cpu_cores : -1));
    write_file(path + "/cpu.weight", std::to_string(std::min(10000, std::max(1, limits.weight))));
    write_file(path + "/memory.max", std::to_string(limits.ram_bytes));
    write_file(path + "/memory.swap.max", "0");   // OOM-kill instead of swapping
    write_file(path + "/memory.oom.group", "1");  // kill the whole task, not one thread
    return path;
}

std::string Cgroups::create_alloc(const std::string& name, double cpu_cores, int64_t ram_bytes) {
    if (!enabled_) return "";
    std::string path = root_ + "/alloc-" + name;
    if (::mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) return "";
    // The alloc's own limits bound everything inside it; its tasks get child cgroups.
    write_file(path + "/cpu.max", cpu_max(cpu_cores));
    write_file(path + "/memory.max", std::to_string(ram_bytes));
    write_file(path + "/memory.swap.max", "0");
    write_file(path + "/cgroup.subtree_control", "+cpu +memory");
    return path;
}

void Cgroups::remove(const std::string& path) {
    if (path.empty()) return;
    // The kernel may need a moment to finish tearing down the last process.
    for (int i = 0; i < 10; ++i) {
        if (::rmdir(path.c_str()) == 0 || errno == ENOENT) return;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
}

bool Cgroups::stats(const std::string& path, Stats* out) const {
    if (path.empty()) return false;
    std::istringstream cpu(read_file(path + "/cpu.stat"));
    std::string key;
    uint64_t val;
    while (cpu >> key >> val)
        if (key == "usage_usec") out->cpu_usec = val;
    std::string mem = read_file(path + "/memory.current");
    if (!mem.empty()) out->mem_bytes = std::stoll(mem);
    std::istringstream ev(read_file(path + "/memory.events"));
    while (ev >> key >> val)
        if (key == "oom_kill") out->oom_kills = static_cast<int>(val);
    return true;
}

bool Cgroups::proc_stats(pid_t pid, Stats* out) {
#if defined(__APPLE__)
    struct rusage_info_v2 ri;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V2, reinterpret_cast<rusage_info_t*>(&ri)) != 0) return false;
    static mach_timebase_info_data_t tb = [] {
        mach_timebase_info_data_t t;
        mach_timebase_info(&t);
        return t;
    }();
    uint64_t ns = (ri.ri_user_time + ri.ri_system_time) * tb.numer / tb.denom;
    out->cpu_usec = ns / 1000;
    // The footprint also counts memory that macOS has compressed; the resident size does not.
    out->mem_bytes = static_cast<int64_t>(ri.ri_phys_footprint);
    return true;
#else
    std::string stat = read_file("/proc/" + std::to_string(pid) + "/stat");
    auto paren = stat.rfind(')');  // the process name may contain spaces
    if (paren == std::string::npos) return false;
    std::istringstream rest(stat.substr(paren + 2));
    std::string field;
    unsigned long long utime = 0, stime = 0;
    for (int i = 3; i <= 15 && rest >> field; ++i) {  // fields 14 and 15: utime, stime (ticks)
        if (i == 14) utime = std::stoull(field);
        if (i == 15) stime = std::stoull(field);
    }
    long hz = ::sysconf(_SC_CLK_TCK);
    out->cpu_usec = (utime + stime) * 1000000ULL / static_cast<unsigned long long>(hz > 0 ? hz : 100);
    std::istringstream statm(read_file("/proc/" + std::to_string(pid) + "/statm"));
    long long pages = 0, resident = 0;
    statm >> pages >> resident;
    out->mem_bytes = resident * ::sysconf(_SC_PAGESIZE);
    return true;
#endif
}

bool Cgroups::join(const char* procs_path) {
    int fd = ::open(procs_path, O_WRONLY);
    if (fd < 0) return false;
    bool ok = ::write(fd, "0", 1) == 1;
    ::close(fd);
    return ok;
}

}  // namespace borglet
