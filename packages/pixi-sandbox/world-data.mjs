import fs from 'node:fs';
import path from 'node:path';

const WORLDS_ROOT = process.env.WENYOU_WORLDS_ROOT;

export function loadWorldPayload(worldId) {
  if (!WORLDS_ROOT) throw new Error('请设置 WENYOU_WORLDS_ROOT 为世界资料的 worlds 目录');
  const worldDir = path.join(WORLDS_ROOT, worldId);
  const world = JSON.parse(fs.readFileSync(path.join(worldDir, 'world.json'), 'utf8'));
  const current = JSON.parse(fs.readFileSync(path.join(worldDir, 'current.json'), 'utf8'));
  const commitDir = path.join(worldDir, 'commits', current.commitId);
  const snapshot = JSON.parse(fs.readFileSync(path.join(commitDir, 'snapshot.json'), 'utf8'));
  const events = fs.readFileSync(path.join(commitDir, 'events.jsonl'), 'utf8')
    .split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  return { world, current, snapshot, events };
}
