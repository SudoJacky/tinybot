import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "lucide-react";

import type {
  TinyOsTimeMachineBoundary,
  TinyOsTimeMachineIndex,
} from "../../app-core/chat/tinyOsTimeMachine";

const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

export function TinyOsTimeMachine({
  currentEventIndex,
  index,
  live,
  onReturnToLive,
  onSelect,
}: {
  currentEventIndex: number;
  index: TinyOsTimeMachineIndex;
  live: boolean;
  onReturnToLive: () => void;
  onSelect: (boundary: TinyOsTimeMachineBoundary) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof REPLAY_SPEEDS)[number]>(1);
  const onSelectRef = useRef(onSelect);
  const lastEventIndex = index.eventCount - 1;
  const boundary = index.boundaries[currentEventIndex];
  const previous = index.boundaries[currentEventIndex - 1];
  const next = index.boundaries[currentEventIndex + 1];

  useEffect(() => {
    if (live || !playing) return;
    if (!next) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => onSelectRef.current(next), 800 / speed);
    return () => window.clearTimeout(timer);
  }, [live, next, playing, speed]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (live) setPlaying(false);
  }, [live]);

  if (!index.eventCount) {
    return (
      <section aria-label="Time Machine" className="tinyos-time-machine" data-empty="true">
        <strong>Time Machine</strong>
        <span>No canonical event boundaries are available.</span>
        {!live ? (
          <div className="tinyos-time-machine__controls">
            <button className="tinyos-time-machine__live" type="button" onClick={onReturnToLive}>
              <RotateCcw aria-hidden="true" size={13} />Return to Live
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  function select(nextBoundary: TinyOsTimeMachineBoundary | undefined) {
    if (!nextBoundary) return;
    setPlaying(false);
    onSelect(nextBoundary);
  }

  return (
    <section aria-label="Time Machine" className="tinyos-time-machine" data-live={live ? "true" : undefined}>
      <div className="tinyos-time-machine__heading">
        <div>
          <small>{live ? "Live boundary" : "Historical boundary"}</small>
          <strong>Time Machine</strong>
        </div>
        <span aria-live="polite">
          Event {currentEventIndex + 1} of {index.eventCount}
        </span>
      </div>

      <div className="tinyos-time-machine__controls">
        <button aria-label="Previous canonical event" disabled={!previous} type="button" onClick={() => select(previous)}>
          <ChevronLeft aria-hidden="true" size={14} />
        </button>
        <button
          aria-label={playing ? "Pause historical replay" : "Play historical replay"}
          disabled={live || (!next && !playing)}
          type="button"
          onClick={() => setPlaying((current) => !current)}
        >
          {playing ? <Pause aria-hidden="true" size={13} /> : <Play aria-hidden="true" size={13} />}
        </button>
        <label>
          <span>Canonical event boundary</span>
          <input
            aria-label="Canonical event boundary"
            max={lastEventIndex}
            min={0}
            step={1}
            type="range"
            value={currentEventIndex}
            onChange={(event) => select(index.boundaries[Number(event.currentTarget.value)])}
          />
        </label>
        <button aria-label="Next canonical event" disabled={!next} type="button" onClick={() => select(next)}>
          <ChevronRight aria-hidden="true" size={14} />
        </button>
        <label className="tinyos-time-machine__speed">
          <span>Replay speed</span>
          <select aria-label="Replay speed" value={speed} onChange={(event) => setSpeed(Number(event.currentTarget.value) as typeof speed)}>
            {REPLAY_SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
        {!live ? (
          <button className="tinyos-time-machine__live" type="button" onClick={onReturnToLive}>
            <RotateCcw aria-hidden="true" size={13} />Return to Live
          </button>
        ) : null}
      </div>

      <ul aria-label="Canonical event groups" className="tinyos-time-machine__groups">
        {index.groups.map((group) => (
          <li key={group.id}>
            <button
              aria-current={group.boundaryIndexes.includes(currentEventIndex) ? "true" : undefined}
              type="button"
              onClick={() => select(index.boundaries[group.firstEventIndex])}
            >
              <span>{group.label}</span><small>{group.boundaryIndexes.length} events</small>
            </button>
          </li>
        ))}
      </ul>

      <div className="tinyos-time-machine__boundary">
        <span data-kind={boundary.kind}>{boundary.title}</span>
        <span>{boundary.kind.replace(/_/g, " ")} · {boundary.status} · revision {boundary.revision}</span>
        {boundary.wallClockTime
          ? <time dateTime={boundary.wallClockTime}>{boundary.wallClockTime}</time>
          : <span data-unavailable="true">Wall-clock time unavailable</span>}
      </div>
    </section>
  );
}
