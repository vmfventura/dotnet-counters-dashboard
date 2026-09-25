// LoadApp: a small workload generator for trying out .NET Counters Dashboard.
//
// It cycles through phases that each trigger one of the dashboard's detections:
//
//   Idle             light background activity
//   CpuHotspot       all cores busy                      -> performance hotspot
//   GcPressure       many short-lived allocations        -> high GC activity
//   MemoryGrowth     objects retained, then released    -> working set / GC heap growth
//   LockContention   threads competing for one lock      -> lock contentions
//
// Usage: dotnet run --project sample/LoadApp [-- <seconds per phase>]

using System.Diagnostics;

var phaseDuration = TimeSpan.FromSeconds(args.Length > 0 && int.TryParse(args[0], out var s) && s > 0 ? s : 15);

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true; // let the workload stop gracefully
    cts.Cancel();
};

Console.WriteLine($"LoadApp (PID {Environment.ProcessId})");
Console.WriteLine($"Each phase lasts {phaseDuration.TotalSeconds:0} s. Press Ctrl+C to exit.");
Console.WriteLine();

try
{
    await Workload.RunAsync(phaseDuration, cts.Token);
}
catch (OperationCanceledException)
{
    // Ctrl+C
}

Console.WriteLine("Stopped.");

internal enum Phase
{
    Idle,
    CpuHotspot,
    GcPressure,
    MemoryGrowth,
    LockContention,
}

internal static class Workload
{
    private static readonly List<byte[]> Retained = [];
    private static readonly object SharedLock = new();

    public static async Task RunAsync(TimeSpan phaseDuration, CancellationToken cancellationToken)
    {
        // Low-level activity in every phase, so the charts never go completely flat.
        var background = Task.Run(() => BackgroundActivityAsync(cancellationToken), cancellationToken);

        while (!cancellationToken.IsCancellationRequested)
        {
            foreach (var phase in Enum.GetValues<Phase>())
            {
                Console.WriteLine($"{DateTime.Now:HH:mm:ss}  {Describe(phase)}");
                await RunPhaseAsync(phase, phaseDuration, cancellationToken);
            }
        }

        await background;
    }

    private static string Describe(Phase phase) => phase switch
    {
        Phase.Idle => "Idle            light background activity",
        Phase.CpuHotspot => "CPU hotspot     all cores busy",
        Phase.GcPressure => "GC pressure     many short-lived allocations",
        Phase.MemoryGrowth => "Memory growth   retaining objects, released at the end of the phase",
        Phase.LockContention => "Lock contention threads competing for a single lock",
        _ => phase.ToString(),
    };

    private static async Task RunPhaseAsync(Phase phase, TimeSpan duration, CancellationToken cancellationToken)
    {
        // Awaited inside the method, so the source (and its timer) lives until the phase ends.
        using var phaseCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        phaseCts.CancelAfter(duration);
        var token = phaseCts.Token;

        await (phase switch
        {
            Phase.Idle => Task.Delay(duration, cancellationToken),
            Phase.CpuHotspot => OnAllCoresAsync(BurnCpu, token, cancellationToken),
            Phase.GcPressure => OnAllCoresAsync(AllocateShortLived, token, cancellationToken),
            Phase.MemoryGrowth => GrowMemoryAsync(duration, cancellationToken),
            Phase.LockContention => OnAllCoresAsync(ContendForLock, token, cancellationToken, threadsPerCore: 4),
            _ => Task.CompletedTask,
        });
    }

    /// <summary>Runs <paramref name="work"/> on dedicated threads (per logical processor) until the phase ends.</summary>
    private static async Task OnAllCoresAsync(Action<CancellationToken> work, CancellationToken phaseToken, CancellationToken cancellationToken, int threadsPerCore = 1)
    {
        var workers = Enumerable.Range(0, Environment.ProcessorCount * threadsPerCore)
            .Select(_ => Task.Factory.StartNew(() => work(phaseToken), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default));
        await Task.WhenAll(workers);
        cancellationToken.ThrowIfCancellationRequested();
    }

    private static void BurnCpu(CancellationToken token)
    {
        var x = 0.0;
        while (!token.IsCancellationRequested)
        {
            for (var i = 0; i < 100_000; i++)
            {
                x += Math.Sqrt(i) * Math.Sin(i);
            }
        }

        GC.KeepAlive(x);
    }

    private static void AllocateShortLived(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            for (var i = 0; i < 1_000; i++)
            {
                _ = new byte[Random.Shared.Next(1_000, 32_000)];
            }

            Thread.Sleep(1);
        }
    }

    private static async Task GrowMemoryAsync(TimeSpan duration, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < duration)
        {
            // ~20 MB per second, kept alive until the end of the phase
            for (var i = 0; i < 20; i++)
            {
                var block = new byte[1024 * 1024];
                block.AsSpan().Fill(0xAB); // write every page, otherwise the OS does not count it in the working set
                Retained.Add(block);
            }

            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
        }

        Retained.Clear();
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);
    }

    private static void ContendForLock(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            // More threads than cores compete for the lock, so waiters cannot all spin and have to block.
            lock (SharedLock)
            {
                Thread.SpinWait(20_000);
            }
        }
    }

    private static async Task BackgroundActivityAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            for (var i = 0; i < 200; i++)
            {
                _ = new byte[Random.Shared.Next(100, 8_000)];
            }

            // an occasional handled exception, visible in the exceptions chart
            if (Random.Shared.Next(20) == 0)
            {
                try
                {
                    throw new InvalidOperationException("Simulated failure.");
                }
                catch (InvalidOperationException)
                {
                }
            }

            await Task.Delay(100, cancellationToken);
        }
    }
}
