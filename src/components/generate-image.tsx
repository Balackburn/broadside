"use client";

import { useEffect, useRef, useState } from "react";
import type { LibraryItem } from "./media-library";
import { api, Dialog, Icon, Tabs, Time } from "./ui";

/** What the server says about image generation. It never includes the key, only whether one is set. */
export type Generation = { available: boolean; remaining: number; limit: number; model: string; resets_at: string };

type Shape = "square" | "portrait" | "landscape";
type Made = Omit<LibraryItem, "used_by">;

const PROMPT_MAX = 2000;
const SHAPES: { value: Shape; label: string }[] = [
  { value: "square", label: "Square" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

/** The button that opens the dialog. Shown only where generation is turned on and the person may add media. */
export function GenerateButton({ onClick, className = "btn btn-quiet" }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" className={className} onClick={onClick}>
      <Icon name="image" size={16} />
      Generate an image
    </button>
  );
}

/**
 * Write a prompt, wait, then keep the picture or let it go. `onMade` is told
 * about every picture as it arrives (it is in the library from that moment),
 * `onUse` when the person presses Use it, and `onDiscarded` when they delete one.
 */
type Props = {
  generation: Generation;
  onGeneration: (next: Generation) => void;
  /** What Use it does here, as one short sentence. */
  useHint: string;
  onMade?: (media: Made) => void;
  onUse: (media: Made) => void;
  onDiscarded?: (media: Made) => void;
};

export function GenerateDialog({ open, onClose, generation, onGeneration, useHint, onMade, onUse, onDiscarded }: Props & { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Generate an image">
      {/* Mounted only while open, so closing the dialog stops the wait and clears what was typed. */}
      <Body generation={generation} onGeneration={onGeneration} useHint={useHint} onMade={onMade} onUse={onUse} onDiscarded={onDiscarded} />
    </Dialog>
  );
}

function Body({ generation, onGeneration, useHint, onMade, onUse, onDiscarded }: Props) {
  const [prompt, setPrompt] = useState("");
  const [shape, setShape] = useState<Shape>("square");
  const [phase, setPhase] = useState<"write" | "working" | "done">("write");
  const [made, setMade] = useState<Made | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const waiting = useRef<AbortController | null>(null);

  // Closing the dialog while an image is being made stops the wait, the same as Stop waiting.
  useEffect(() => () => waiting.current?.abort(), []);

  const length = prompt.trim().length;
  const tooLong = length > PROMPT_MAX;
  const none = generation.remaining <= 0;

  /** Asks the server again how many are left: after a wait was stopped, the count is whatever the server now says. */
  const recount = () =>
    api<Generation>("/media/generate")
      .then(onGeneration)
      .catch(() => undefined);

  async function generate() {
    if (!length || tooLong || none) return;
    const controller = new AbortController();
    waiting.current = controller;
    setPhase("working");
    setError(null);
    setNote(null);
    try {
      const result = await api<{ media: Made; remaining: number; limit: number; resets_at: string }>("/media/generate", { method: "POST", body: JSON.stringify({ prompt, shape }), signal: controller.signal });
      if (controller.signal.aborted) return;
      setMade(result.media);
      onGeneration({ ...generation, remaining: result.remaining, limit: result.limit, resets_at: result.resets_at });
      onMade?.(result.media);
      setPhase("done");
    } catch (cause) {
      // Stopped by the person: stop() has already said what that means.
      if (controller.signal.aborted) return;
      setError((cause as Error).message);
      setPhase("write");
      void recount();
    }
  }

  function stop() {
    waiting.current?.abort();
    setPhase("write");
    setNote("Stopped waiting. OpenAI may still finish the image. If it does, it is added to the library and counts against today.");
    void recount();
  }

  async function discard() {
    if (!made) return;
    setDiscarding(true);
    try {
      await api(`/media/${made.id}`, { method: "DELETE" });
      onDiscarded?.(made);
      setMade(null);
      setPhase("write");
      setNote("Deleted that image. It was already billed, so it still counts against today.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setDiscarding(false);
    }
  }

  const billing = (
    <p className="note text-[13px]">
      Each image is billed to the OpenAI account whose key is on this server.{" "}
      {none ? (
        <>
          Today&apos;s {generation.limit === 1 ? "image has" : `${generation.limit} images have`} been generated. The count starts again at <Time iso={generation.resets_at} />.
        </>
      ) : (
        <span className="num">
          {generation.remaining} of {generation.limit} left today.
        </span>
      )}
    </p>
  );

  if (phase === "working") {
    return (
      <div role="status" aria-live="polite">
        <div className="thumb grid place-items-center text-ink-3">
          <span className="spinner" />
        </div>
        <p className="mt-4 text-[15px] font-medium">
          <span className="shimmer">Generating the image</span>
        </p>
        <p className="note mt-1 text-[13px]">This usually takes under a minute and can take up to two. You can stop waiting; the image may still be made and billed.</p>
        <div className="mt-6 flex justify-end">
          <button type="button" className="btn btn-quiet" onClick={stop}>
            Stop waiting
          </button>
        </div>
      </div>
    );
  }

  if (phase === "done" && made) {
    return (
      <div>
        <a className="thumb" href={made.url} target="_blank" rel="noreferrer" aria-label="Open the image at full size">
          {/* eslint-disable-next-line @next/next/no-img-element -- generated images are served from the data directory like every other upload */}
          <img src={made.url} alt={made.alt ?? ""} className="object-contain" />
        </a>
        <label className="label mt-4" htmlFor="generated-alt">
          Description for screen readers
        </label>
        <input
          id="generated-alt"
          className="field"
          defaultValue={made.alt ?? ""}
          onBlur={(event) => {
            const alt = event.target.value;
            if (alt.trim() === (made.alt ?? "")) return;
            void api<Made>(`/media/${made.id}`, { method: "PATCH", body: JSON.stringify({ alt }) })
              .then((saved) => setMade({ ...made, alt: saved.alt }))
              .catch((cause: Error) => setError(cause.message));
          }}
        />
        <p className="note mt-1 text-[13px]">It starts as your prompt. Change it to say what the picture shows.</p>
        {error ? (
          <p className="mt-3 text-sm font-medium text-bad" role="alert">
            {error}
          </p>
        ) : null}
        <p className="note mt-4 text-[13px]">
          {useHint} Try again makes a new image from the same prompt: it counts against today, and this one stays in the library. Discard deletes this image.{" "}
          {none ? "There are none left today." : <span className="num">{`${generation.remaining} of ${generation.limit} left today.`}</span>}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn btn-bare" onClick={discard} disabled={discarding}>
            {discarding ? <span className="spinner" /> : null}
            Discard
          </button>
          <button type="button" className="btn btn-quiet" onClick={generate} disabled={none || discarding}>
            Try again
          </button>
          <button type="button" className="btn" onClick={() => onUse(made)} disabled={discarding}>
            Use it
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void generate();
      }}
    >
      <label className="label" htmlFor="generate-prompt">
        Prompt
      </label>
      <textarea
        id="generate-prompt"
        data-autofocus
        className="field min-h-28 resize-y"
        rows={4}
        placeholder="Describe the image: what is in it, the style, the light."
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        aria-invalid={tooLong}
        aria-describedby="generate-count"
      />
      <p id="generate-count" className={`num mt-1 text-right text-[13px] ${tooLong ? "font-medium text-bad" : "text-ink-3"}`}>
        {tooLong ? `${length} of ${PROMPT_MAX} characters. Shorten the prompt by ${length - PROMPT_MAX}.` : `${length} of ${PROMPT_MAX} characters`}
      </p>
      <p className="label mt-3">
        Shape
      </p>
      <Tabs label="Shape of the image" value={shape} onChange={setShape} options={SHAPES} />
      {error ? (
        <p className="mt-4 text-sm font-medium text-bad" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="note mt-4 text-[13px]" role="status">
          {note}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-56">{billing}</div>
        <button type="submit" className="btn flex-none" disabled={!length || tooLong || none}>
          Generate
        </button>
      </div>
    </form>
  );
}
