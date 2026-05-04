import { useEffect, useRef, useState } from "react";

const PHASES = [
  {
    messages: ["Initializing model…", "Preparing your prompt…", "Loading styles and references…"],
    duration: 3000,
  },
  {
    messages: ["Generating composition…", "Blocking shapes and layout…", "Refining details…", "Enhancing lighting and textures…"],
    duration: 10000,
  },
  {
    messages: ["Improving quality…", "Fixing artifacts…", "Upscaling image…"],
    duration: 10000,
  },
  {
    messages: ["Final touches…", "Packaging result…", "Almost done…"],
    duration: Infinity,
  },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function useGeneratingPhase(busy: boolean): string {
  const [label, setLabel] = useState<string>("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };

    if (!busy) { clear(); setLabel(""); return; }

    clear();
    setLabel(pick(PHASES[0].messages));

    let delay = PHASES[0].duration;
    for (let i = 1; i < PHASES.length; i++) {
      const msgs = PHASES[i].messages;
      const t = setTimeout(() => setLabel(pick(msgs)), delay);
      timers.current.push(t);
      if (PHASES[i].duration === Infinity) break;
      delay += PHASES[i].duration;
    }

    return clear;
  }, [busy]);

  return label;
}
