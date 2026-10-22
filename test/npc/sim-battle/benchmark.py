"""Paired Hard/Normal matches from a local NPC team pool; swap teams in every pair."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import random
import re
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool', default='npc1')
    parser.add_argument('--replay-manifest', type=Path, help='Replay the exact cases, teams, sides and seeds in a saved manifest')
    parser.add_argument('--pairs', type=int, default=5)
    parser.add_argument('--offset', type=int, default=0, help='Skip pairs reserved for previous tuning')
    parser.add_argument('--seed', type=int, default=21021026)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--timeout', type=int, default=240, help='Wall-clock seconds per match; turn limit stays 300')
    parser.add_argument('--format', default='gen6ou')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.pairs < 1 or args.offset < 0 or not 1 <= args.workers <= 8 or args.timeout < 1:
        parser.error('pairs and timeout must be positive, offset nonnegative, workers between 1 and 8')
    root = Path(__file__).resolve().parents[3]
    if args.replay_manifest:
        metadata = json.loads(args.replay_manifest.read_text())
        cases = metadata['cases']
        args.format = metadata['format']
        if not cases or len({case['id'] for case in cases}) != len(cases):
            parser.error('Replay manifest must contain unique, nonempty cases')
        metadata = dict(metadata, replaySource=str(args.replay_manifest.resolve()), timeout=args.timeout)
    else:
        pool = json.loads((root / 'data/npc/templates.json').read_text())[args.pool]['teams']
        pairs = [(a, b) for i, a in enumerate(pool) for b in pool[i + 1:]]
        random.Random(args.seed).shuffle(pairs)
        if args.offset + args.pairs > len(pairs):
            parser.error(f'Pool only contains {len(pairs)} distinct team pairs')
        cases = []
        for i in range(args.offset, args.offset + args.pairs):
            a, b = pairs[i]
            for reverse in (False, True):
                cases.append(dict(id=f'{i + 1:03d}{"b" if reverse else "a"}',
                                  teams=[b, a] if reverse else [a, b],
                                  p1='normal' if i % 2 == 0 else 'hard', seed=f'{i + 101},21,10,26'))
        metadata = dict(pool=args.pool, format=args.format, shuffleSeed=args.seed,
                        offset=args.offset, pairs=args.pairs, timeout=args.timeout, cases=cases)
    output = args.output or Path(tempfile.mkdtemp(prefix='npc-benchmark-'))
    if args.output:
        output.mkdir(parents=True, exist_ok=False)
    (output / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')

    def run(case):
        command = ['node', 'dist/test/npc/sim-battle/runner.js', '--format', args.format,
                   '--game-type', 'singles', '--player', 'data/npc/teams/' + case['teams'][0],
                   '--npc', 'data/npc/teams/' + case['teams'][1], '--p1-strategy', 'mirror-npc',
                   '--p1-difficulty', case['p1'], '--npc-difficulty',
                   'hard' if case['p1'] == 'normal' else 'normal', '--seed', case['seed'],
                   '--max-turns', '300', '--log-level', 'VERBOSE']
        timed_out = False
        with (output / (case['id'] + '.log')).open('w') as stdout, \
                (output / (case['id'] + '.err')).open('w') as stderr:
            try:
                process = subprocess.run(command, cwd=root, stdout=stdout, stderr=stderr, timeout=args.timeout)
                code = process.returncode
            except subprocess.TimeoutExpired:
                code, timed_out = None, True
        log = (output / (case['id'] + '.log')).read_text()
        error = (output / (case['id'] + '.err')).read_text()
        win = re.search(r'^\|win\|(.+)$', log, re.M)
        turns = re.findall(r'^\|turn\|(\d+)$', log, re.M)
        if code != 0 or timed_out:
            winner = 'error'
        elif win:
            winner = case['p1'] if win[1] == 'Player' else ('hard' if case['p1'] == 'normal' else 'normal')
        elif 'maxTurns=' in error:
            winner = 'capped'
        elif re.search(r'^\|tie(?:\||$)', log, re.M):
            winner = 'tie'
        else:
            winner = 'error'
        return dict(**case, winner=winner, turns=int(turns[-1]) if turns else 0,
                    exit=code, timedOut=timed_out)

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as workers:
        for future in concurrent.futures.as_completed([workers.submit(run, case) for case in cases]):
            results.append(future.result())
            summary = dict(format=args.format, games=len(results),
                           wins={kind: sum(r['winner'] == kind for r in results)
                                 for kind in ['hard', 'normal', 'tie', 'capped', 'error']},
                           results=sorted(results, key=lambda r: r['id']))
            (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
            print(f"{len(results)}/{len(cases)} {summary['wins']}", flush=True)
    print(f'Replays and manifest: {output}')
    if summary['wins']['error']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
