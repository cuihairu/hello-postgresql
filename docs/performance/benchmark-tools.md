# Benchmark Tools

Every tuning decision should be backed by numbers, and pgbench is the standard benchmark tool that ships with PostgreSQL: no extra install, it runs the built-in workload or your own transaction mix, which is enough for the everyday validation of "parameter A/B", "hardware selection", and "the payoff of a SQL rewrite". This page records the built-in tests versus custom scripts, concurrency and data scale, metric definitions, and how to run a comparison experiment.

## The Built-in Test: tpcb-like and Its Three Variants

Two steps: initialize (create tables and load data), then benchmark.

```bash
# initialize, scale factor 100: the accounts table has 10 million rows, data in the GB range
pgbench -h localhost -U postgres -i -s 100 benchdb

# benchmark: 32 clients, 8 threads, run for 5 minutes (the default built-in script is tpcb-like)
pgbench -h localhost -U postgres -c 32 -j 8 -T 300 benchdb
```

`-b` selects a built-in script: `tpcb-like` (the default, point reads + balance updates + history), `select-only` (pure reads), `simple-update` (light writes). Switching scripts is faster than writing your own when comparing "mostly reads" against "write-heavy".

## Custom Scripts: Random Parameters and Transaction Ratios

Inside a script, `\set` generates random parameters to simulate real requests:

```plaintext
-- update-account.sql: random account transfers
\set aid random_gaussian(1, 100000 * :scale, 10)
\set delta random(-5000, 5000)
BEGIN;
UPDATE pgbench_accounts SET abalance = abalance + :delta WHERE aid = :aid;
SELECT abalance FROM pgbench_accounts WHERE aid = :aid;
UPDATE pgbench_tellers SET tbalance = tbalance + :delta WHERE tid = :aid % (10 * :scale) + 1;
COMMIT;
```

- `random(lo, hi)` is uniform; `random_gaussian(lo, hi, threshold)` clusters in the middle to simulate hotspots; `random_zipfian` (PG 11+) simulates a skewed access pattern where a few keys dominate—concurrency problems on hot rows (see [Lock and Concurrency Bottlenecks](./lock-and-concurrency-bottlenecks)) should be provoked with zipfian.
- Transaction ratios are controlled by script weights, where `@` is followed by the weight:

```bash
# reads : writes = 9 : 1
pgbench -c 32 -j 8 -T 300 -f read.sql@9 -f write.sql@1 benchdb
```

## Scale Factor and Concurrency Design

- **Scale factor sets the data volume**: accounts rows = 100000 × SF. Choose an SF that puts the data far above shared_buffers (to exercise the disk path) or far below it (to exercise the CPU/lock path); do not mix the two purposes into one result.
- **Concurrency sets the shape of the load test**: `-c` is the client count, `-j` the thread count (each thread runs c/j clients). Step up the client count from around the core count (say 8/16/32/64/128) and plot TPS and latency curves: the knee where TPS stops rising and latency starts climbing steeply is the capacity boundary for this parameter set.
- A client count far above the core count only adds scheduling overhead and lock queueing; the numbers it produces do not represent production.

## Metric Definitions

pgbench's closing output gives two core numbers:

```plaintext
number of transactions actually processed: ...
latency average = 12.345 ms          -- average latency per transaction (includes waits, excludes connection setup)
initial connection time = ...
tps = 2597.123456 (without initial connection time)
```

- **TPS**: transactions completed per second; note whether the parenthetical includes connection setup time—the difference is large on short runs, so a duration `-T` of at least 5 minutes makes it negligible;
- **latency average**: average latency; only the mean is available. Percentiles (p95/p99) are not given directly—use `-l` to log each transaction and compute them yourself; `-P 10` prints progress every 10 seconds so you can watch mid-run;
- `--rate N` switches clients to sending at a fixed arrival rate (Poisson); combined with `--latency-limit` you can define "anything over X ms counts as a failure", and the latency distribution measured is closer to a production shape—closed-loop benchmarking (pushing as hard as the client count allows) distorts under heavy load;
- `-r` prints the average latency of each statement in the script, so you can find which SQL inside the script is holding things up.

## Fixed Steps Before and After a Test

```sql
-- 1. after loading data, always ANALYZE; otherwise the planner has no statistics and the results are untrustworthy
ANALYZE;

-- 2. record checkpoint and WAL counters before and after, to see whether the test itself was disturbed by flushing
SELECT checkpoints_timed, checkpoints_req FROM pg_stat_bgwriter;
-- since PG 17, checkpoint statistics have moved to a dedicated view:
SELECT num_timed, num_requested FROM pg_stat_checkpointer;

SELECT wal_bytes FROM pg_stat_wal;   -- PG 14+, to assess WAL write volume
```

- Cover at least 2-3 checkpoint cycles (the default `checkpoint_timeout` is 5 minutes), or a lucky "just missed a checkpoint" result will mislead the comparison; checkpoint mechanics are in [Checkpoint and Buffer](../internals/checkpoint-and-buffer).
- In a comparison experiment, checkpoint-related parameters (`max_wal_size`, `checkpoint_timeout`) must be identical on both sides.
- Run one warm-up pass to heat the buffers, discard its results, then start the real timing.

## A/B Comparison Experiment Design

- **Single variable**: change one thing at a time (a parameter, a SQL statement, an index), and freeze everything else—same machine, same data, same concurrency, same duration.
- **Repeat and take the median**: at least 3-5 runs per configuration, reporting the median and the spread; single-run noise can exceed the gap you are trying to prove.
- **Reproducible data**: rebuild the same scale factor dataset with `pgbench -i` each time, or take a snapshot dump beforehand and restore before testing.
- **Record the environment**: an instance parameter snapshot (`SELECT name, setting FROM pg_settings WHERE source <> 'default';`), hardware model, and PG minor version all go in the report, so results are reproducible three months later.
- Write only numbers and confidence ranges as conclusions: "p95 dropped from 12ms to 8ms, TPS up 18%", not "visibly faster".

Beyond pgbench, sysbench, TPC-C implementations (BenchmarkSQL, TPCC-UVA), and HammerDB can be used for cross-database or more complex business workloads; pgbench is usually sufficient for everyday single-node verification.

## References

- [PostgreSQL Official Documentation · pgbench](https://www.postgresql.org/docs/current/pgbench.html)
- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [capacity-and-scaling-limits](capacity-and-scaling-limits.md)
- [index](index.md)
- [parameter-tuning](parameter-tuning.md)
- [write-throughput-optimization](write-throughput-optimization.md)- [Parameter Tuning](./parameter-tuning)——the basis for the values of the parameters under test.
- [Write Throughput Optimization](./write-throughput-optimization)——the concrete measures for the write path.
- [Lock and Concurrency Bottlenecks](./lock-and-concurrency-bottlenecks)——a framework for interpreting high-concurrency benchmark results.
- [Checkpoint and Buffer](../internals/checkpoint-and-buffer)——one of the sources of benchmark interference.

Official docs: <https://www.postgresql.org/docs/current/pgbench.html>
