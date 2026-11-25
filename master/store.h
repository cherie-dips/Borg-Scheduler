// The Borgmaster's durable state (§3.1): "a periodic snapshot plus a change log". Every object
// of the cell's state (a job, a task, a machine, ...) is stored as JSON under a key. A change
// appends one line to the log; now and then the whole state is written as a snapshot and the
// log starts again. After a restart the Borgmaster reads the snapshot, replays the log, and
// carries on: the tasks on the machines never stopped.
//
// In the paper the store is replicated with Paxos on the disks of the five Borgmaster replicas.
// Here it is a directory, which the replicas of one cell share.
#pragma once

#include <unistd.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <string>

#include "json.hpp"

namespace borg {

class Store {
public:
    using json = nlohmann::json;

    explicit Store(std::string dir) : dir_(std::move(dir)) {
        if (dir_.empty()) return;
        std::error_code ec;
        std::filesystem::create_directories(dir_, ec);
    }

    bool enabled() const { return !dir_.empty(); }
    const std::string& dir() const { return dir_; }
    uint64_t seq() const { return seq_; }
    uint64_t snapshot_seq() const { return snapshot_seq_; }
    size_t log_entries() const { return log_entries_; }

    // Reads the snapshot and replays the log on top of it. Returns the objects by key.
    std::map<std::string, json> load() {
        std::map<std::string, json> objects;
        if (!enabled()) return objects;
        std::ifstream snap(dir_ + "/snapshot.json");
        if (snap) {
            json s = json::parse(snap, nullptr, false);
            if (s.is_object() && s.contains("objects")) {
                seq_ = snapshot_seq_ = s.value("seq", uint64_t{0});
                for (auto& [key, value] : s["objects"].items()) objects[key] = value;
            }
        }
        log_entries_ = replay(objects);
        return objects;
    }

    // Applies the log entries after `after` to `objects` and returns how many there were.
    // Replicas that follow the elected master call this to stay up to date.
    size_t follow(std::map<std::string, json>& objects, uint64_t* after) {
        if (!enabled()) return 0;
        uint64_t snap_seq = 0;
        {
            std::ifstream snap(dir_ + "/snapshot.json");
            json s = snap ? json::parse(snap, nullptr, false) : json();
            if (s.is_object()) snap_seq = s.value("seq", uint64_t{0});
            if (s.is_object() && snap_seq > *after) {  // the log restarted: take the snapshot first
                objects.clear();
                for (auto& [key, value] : s["objects"].items()) objects[key] = value;
                *after = snap_seq;
            }
        }
        seq_ = *after;
        size_t n = replay(objects);
        *after = seq_;
        return n;
    }

    // Records that `key` now has `value` (or, with nullptr, that it is gone).
    void append(const std::string& key, const json* value) {
        if (!enabled()) return;
        if (!log_.is_open()) log_.open(dir_ + "/changes.log", std::ios::app);
        json entry = {{"seq", ++seq_}, {"key", key}};
        if (value) entry["value"] = *value;
        else entry["del"] = true;
        log_ << entry.dump() << "\n";
        log_entries_++;
    }

    void flush() {
        if (log_.is_open()) log_.flush();
    }

    // Writes the whole state and starts the log again.
    void snapshot(const std::map<std::string, json>& objects) {
        if (!enabled()) return;
        json s = {{"seq", seq_}, {"objects", json::object()}};
        for (const auto& [key, value] : objects) s["objects"][key] = value;
        std::string tmp = dir_ + "/snapshot.json.tmp";
        {
            std::ofstream f(tmp, std::ios::trunc);
            f << s.dump();
        }
        std::rename(tmp.c_str(), (dir_ + "/snapshot.json").c_str());
        if (log_.is_open()) log_.close();
        log_.open(dir_ + "/changes.log", std::ios::trunc);
        snapshot_seq_ = seq_;
        log_entries_ = 0;
    }

private:
    size_t replay(std::map<std::string, json>& objects) {
        std::ifstream log(dir_ + "/changes.log");
        size_t n = 0;
        for (std::string line; std::getline(log, line);) {
            json e = json::parse(line, nullptr, false);
            if (!e.is_object()) break;  // a torn last line: the master died while writing it
            uint64_t s = e.value("seq", uint64_t{0});
            if (s <= seq_) continue;  // already in the snapshot (or already applied)
            seq_ = s;
            if (e.value("del", false)) objects.erase(e.value("key", ""));
            else objects[e.value("key", "")] = e["value"];
            n++;
        }
        return n;
    }

    std::string dir_;
    std::ofstream log_;
    uint64_t seq_ = 0, snapshot_seq_ = 0;
    size_t log_entries_ = 0;
};

}  // namespace borg
