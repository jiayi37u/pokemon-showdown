"""AI matches from a local NPC team pool; self-play samples each team pair once."""
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
    parser.add_argument('--self-play', action='store_true', help='Run Hard against Hard')
    parser.add_argument('--replay-manifest', type=Path, help='Replay the exact cases, teams, sides and seeds in a saved manifest')
    parser.add_argument('--pairs', type=int, default=5)
    parser.add_argument('--offset', type=int, default=0, help='Skip pairs reserved for previous tuning')
    parser.add_argument('--seed', type=int, default=21021026)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--timeout', type=int, help='Seconds per match; 0 disables (self-play: 0, comparison: 240)')
    parser.add_argument('--max-turns', type=int, help='Runner turn limit; 0 disables (self-play: 0, comparison: 300)')
    parser.add_argument('--format', default='gen6ou')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.timeout is None:
        args.timeout = 0 if args.self_play else 240
    if args.max_turns is None:
        args.max_turns = 0 if args.self_play else 300
    if args.pairs < 1 or args.offset < 0 or not 1 <= args.workers <= 8 or args.timeout < 0 or args.max_turns < 0:
        parser.error('pairs must be positive, offset/timeout/max-turns nonnegative, workers between 1 and 8')
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
            for reverse in ((False,) if args.self_play else (False, True)):
                cases.append(dict(id=f'{i + 1:03d}{"b" if reverse else "a"}',
                                  teams=[b, a] if reverse else [a, b],
                                  p1='hard' if args.self_play or i % 2 else 'normal',
                                  p2='hard' if args.self_play or not i % 2 else 'normal',
                                  seed=f'{i + 101},21,10,26'))
        metadata = dict(pool=args.pool, format=args.format, shuffleSeed=args.seed,
                        offset=args.offset, pairs=args.pairs, timeout=args.timeout, cases=cases)
    output = args.output or Path(tempfile.mkdtemp(prefix='npc-benchmark-'))
    if args.output:
        output.mkdir(parents=True, exist_ok=False)
    metadata.update(revision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
                    trackedChanges=subprocess.check_output(['git', 'diff', 'HEAD', '--stat'], cwd=root, text=True),
                    nodeVersion=subprocess.check_output(['node', '--version'], cwd=root, text=True).strip(),
                    maxTurns=args.max_turns,
                    workers=args.workers)
    (output / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')

    def run(case):
        opponent = case.get('p2', 'hard' if case['p1'] == 'normal' else 'normal')
        command = ['node', 'dist/test/npc/sim-battle/runner.js', '--format', args.format,
                   '--game-type', 'singles', '--player', 'data/npc/teams/' + case['teams'][0],
                   '--npc', 'data/npc/teams/' + case['teams'][1], '--p1-strategy', 'mirror-npc',
                   '--p1-difficulty', case['p1'], '--npc-difficulty',
                   opponent, '--seed', case['seed'],
                   '--max-turns', str(args.max_turns), '--log-level', 'VERBOSE']
        timed_out = False
        with (output / (case['id'] + '.log')).open('w') as stdout, \
                (output / (case['id'] + '.err')).open('w') as stderr:
            try:
                process = subprocess.run(command, cwd=root, stdout=stdout, stderr=stderr, timeout=args.timeout or None)
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
            winner = case['p1'] if win[1] == 'Player' else opponent
        elif 'maxTurns=' in error:
            winner = 'capped'
        elif re.search(r'^\|tie(?:\||$)', log, re.M):
            winner = 'tie'
        else:
            winner = 'error'
        return dict(**case, winner=winner, turns=int(turns[-1]) if turns else 0,
                    winnerSide=('p1' if win[1] == 'Player' else 'p2') if win else None,
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
