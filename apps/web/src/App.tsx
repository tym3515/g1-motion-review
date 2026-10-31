import { useEffect } from 'react';
import { duration } from '@g1/core';
import { Notice, TopBar } from './components/TopBar';
import { Viewer } from './components/Viewer';
import { JointList, RulesPanel, Summary } from './components/Panel';
import { CurvePanel, jumpIssue, LiveBar, stepFrame, Timeline, togglePlay, TransportBar } from './components/Dock';
import { InspectorDrawer } from './components/Inspector';
import { useReview } from './store/review';
import { usePlayback } from './store/playback';
import { useLive } from './store/live';
import {mountDemoAI} from '../../../../../shared/demo-ai/client.mjs';

/** 播放时钟：不在实时模式时按帧推进时间；实时模式下时间由数据流驱动。 */
function usePlaybackClock() {
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const pb = usePlayback.getState();
      const planned = useReview.getState().planned;
      if (!pb.playing || !planned || useLive.getState().source) return;
      const dur = duration(planned);
      let t = pb.t + dt * pb.speed;
      if (t >= dur) {
        if (pb.loop) t = 0;
        else { t = dur; pb.setPlaying(false); }
      }
      pb.setT(t);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox' && (el as HTMLInputElement).type !== 'range')) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1, e.shiftKey); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrame(-1, e.shiftKey); }
      else if (e.key === ']') jumpIssue(1);
      else if (e.key === '[') jumpIssue(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useEffect(()=>mountDemoAI({app:'g1-review',getContext:()=>{
    const s=useReview.getState(),a=s.analysis,t=s.planned;return{robot:s.robotName,clip:s.clipId,rules:s.rules,selectedJoint:s.sel,playbackTime:usePlayback.getState().t,frameCount:t?.frameCount,fps:t?.fps,jointNames:t?.jointNames,analysis:a?{verdict:a.verdict,frameCount:a.frameCount,overFrames:a.overFrames,nearFrames:a.nearFrames,velocityFrames:a.velocityFrames,joints:a.joints,segments:a.segments.slice(0,8)}:null,error:s.analyzeError};
  },dark:true}),[]);
  usePlaybackClock();
  useShortcuts();
  useEffect(() => { void useReview.getState().boot(); }, []);

  return (
    <div className="app">
      <div className="head">
        <TopBar />
        <Notice />
      </div>
      <main className="stage">
        <Viewer />
        <aside className="panel" aria-label="检查结果">
          <Summary />
          <RulesPanel />
          <JointList />
        </aside>
      </main>
      <section className="dock" aria-label="时间轴">
        <TransportBar />
        <LiveBar />
        <Timeline />
        <CurvePanel />
      </section>
      <footer className="foot">
        <span>模型：<a href="https://github.com/unitreerobotics/unitree_ros/tree/master/robots/g1_description" target="_blank" rel="noopener">unitree_ros / g1_description</a>（BSD-3-Clause），网格面数简化到约 18%</span>
        <span>动作：<a href="https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset" target="_blank" rel="noopener">Unitree LAFAN1 Retargeting Dataset</a>（BSD-3-Clause），源自 Ubisoft LAFAN1 动捕</span>
        <span>React 19 · TypeScript · Zustand · three.js · Connect RPC · proto：g1.review.v1</span>
      </footer>
      <InspectorDrawer />
    </div>
  );
}
