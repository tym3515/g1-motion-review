import { create } from 'zustand';

interface PlaybackState {
  /** 当前时间，秒。每帧都会变，React 组件不要直接订阅它，用 useThrottledTime 或 subscribe。 */
  t: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  follow: boolean;
  setT(t: number): void;
  setPlaying(v: boolean): void;
  setSpeed(v: number): void;
  setLoop(v: boolean): void;
  setFollow(v: boolean): void;
}

export const usePlayback = create<PlaybackState>((set) => ({
  t: 0,
  playing: false,
  speed: 1,
  loop: true,
  follow: true,
  setT: (t) => set({ t }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setLoop: (loop) => set({ loop }),
  setFollow: (follow) => set({ follow }),
}));
