#!/bin/sh
# Runs the live cell directly on this computer, without Docker: the Borgmaster, five Borglets
# and, with "ha", the paper's full control plane, all as ordinary processes.
#
#   make                          build first
#   tools/cell.sh start           1 Borgmaster on :8080 and 5 Borglets; open http://localhost:8080
#   tools/cell.sh start ha        5 Borgmaster replicas on :8080-:8084, the scheduler process and
#                                 5 Borglets; it prints which page to open (one that follows)
#   tools/cell.sh stop            stop everything (the state is kept until the next start)
#   tools/cell.sh status          what is running
#   tools/cell.sh kill-master     kill the Borgmaster without warning (with ha: the elected one)
#   tools/cell.sh start-master [n]  start it again (with ha: replica n)
#   tools/cell.sh stop-scheduler | start-scheduler     (ha) the separate scheduler process
#   tools/cell.sh logs <name>     for example: logs master, logs master-2, logs borglet-3, logs scheduler
#
# Linux cgroups are not available this way (they are in Docker): CPU limits are not enforced, and
# memory limits are checked by the Borglet itself, which stops a task that goes over.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$REPO/build/cell"
BIN="$RUN/bin"   # the cell runs its own copy of the binaries, so it can be found and stopped by path
PORT="${BORG_PORT:-8080}"              # the Borgmaster's port (replicas use the next four as well)
TASK_PORTS="${BORG_TASK_PORTS:-20000}" # the ports handed to tasks start above this number
if [ "$1" = "start" ]; then
  [ "$2" = "ha" ] && HA=1
elif [ -f "$RUN/ha" ]; then
  HA=1  # the running cell was started with "ha"
fi

MASTERS="http://127.0.0.1:$PORT"
if [ -n "$HA" ]; then
  MASTERS=""
  for r in 1 2 3 4 5; do MASTERS="$MASTERS${MASTERS:+,}http://127.0.0.1:$((PORT + r - 1))"; done
fi

start_master() {  # start_master [replica number]
  cd "$REPO" || exit 1
  if [ -n "$HA" ]; then
    r="${1:-1}"
    nohup "$BIN/borgmaster" --port $((PORT + r - 1)) --ui "$REPO/ui" --state "$RUN/state" \
      --replica "borgmaster-$r" --advertise "http://127.0.0.1:$((PORT + r - 1))" >>"$RUN/master-$r.log" 2>&1 &
    echo $! >"$RUN/master-$r.pid"
  else
    nohup "$BIN/borgmaster" --port "$PORT" --ui "$REPO/ui" --state "$RUN/state" \
      >>"$RUN/master.log" 2>&1 &
    echo $! >"$RUN/master.pid"
  fi
}

start_scheduler() {
  nohup "$BIN/borgscheduler" --master "$MASTERS" >>"$RUN/scheduler.log" 2>&1 &
}

stop() {
  pkill -9 -f "$BIN/borg" 2>/dev/null
  rm -f "$RUN"/*.pid
  true
}

start() {
  [ -x "$REPO/build/bin/borgmaster" ] || { echo "build first: make"; exit 1; }
  stop
  rm -rf "$RUN"
  mkdir -p "$BIN"
  cp "$REPO/build/bin/borgmaster" "$REPO/build/bin/borgscheduler" "$REPO/build/bin/borglet" "$BIN/" || exit 1
  if [ -n "$HA" ]; then
    touch "$RUN/ha"
    for r in 1 2 3 4 5; do start_master $r; sleep 0.3; done
    start_scheduler
  else
    start_master
  fi
  i=1
  for spec in "1 512 rack=r1,ssd=false" "1 512 rack=r1,ssd=false" "2 1024 rack=r2,ssd=true" "2 1024 rack=r2,ssd=true" "1 768 rack=r3,ssd=false"; do
    set -- $spec
    BORGLET_NAME="borglet-$i" BORGLET_PORT=$((PORT + 1010 + i)) BORGLET_CPU="$1" BORGLET_RAM_MB="$2" BORGLET_ATTRS="$3" \
      BORG_MASTER="$MASTERS" BORGLET_ADVERTISE="http://127.0.0.1:$((PORT + 1010 + i))" \
      BORGLET_DIR="$RUN/m$i" BORGLET_PORTS="$((TASK_PORTS + i * 100))-$((TASK_PORTS + i * 100 + 31))" \
      nohup "$BIN/borglet" >"$RUN/borglet-$i.log" 2>&1 &
    echo $! >"$RUN/borglet-$i.pid"
    i=$((i + 1))
  done
  sleep 4
  if [ -n "$HA" ]; then
    name="$(elected)"
    follower=1
    [ "${name##*-}" = "1" ] && follower=2
    echo "cell started: 5 Borgmaster replicas on :$PORT-:$((PORT + 4)), the scheduler process and 5 Borglets"
    echo "open http://localhost:$((PORT + follower - 1))   (borgmaster-$follower; the elected master is $name)"
  else
    echo "cell started: the Borgmaster and 5 Borglets; open http://localhost:$PORT"
  fi
}

elected() {  # name of the elected master, as recorded in the shared state
  sed -n 's/.*"name":"\([^"]*\)".*/\1/p' "$RUN/state/master.json" 2>/dev/null
}

case "$1" in
  start) start ;;
  stop) stop; echo "cell stopped" ;;
  status) ps -axo pid=,command= | grep "$BIN/borg" | grep -v grep | sed "s#$BIN/##" | cut -c1-100 ;;
  kill-master)
    if [ -n "$HA" ]; then
      name="$(elected)"
      kill -9 "$(cat "$RUN/master-${name##*-}.pid")" && echo "killed $name, the elected master"
    else
      pkill -9 -f "$BIN/borgmaster" && echo "killed the Borgmaster"
    fi ;;
  start-master) start_master "$2"; echo "started" ;;
  start-scheduler) start_scheduler ;;
  stop-scheduler) pkill -9 -f "$BIN/borgscheduler" ;;
  logs) tail -n "${3:-40}" "$RUN/$2.log" ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
