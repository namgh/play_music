/**
 * 아이콘 — 1.6 굵기 선으로 직접 그린 것 (시안 v4 와 같은 모양).
 * 이모지·유니코드 기호로 대신하지 않는다: 글꼴마다 모양이 달라진다.
 */
import type { ReactNode } from 'react';

function Line({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  );
}

export const IconPlay = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" /></svg>
);
export const IconStop = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>
);
export const IconRewind = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M6 5v14" /><path d="M19 5l-9 7 9 7z" /></Line>
);
export const IconLoop = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M17 3l3 3-3 3" /><path d="M4 11V9a3 3 0 0 1 3-3h13" /><path d="M7 21l-3-3 3-3" /><path d="M20 13v2a3 3 0 0 1-3 3H4" /></Line>
);
export const IconMetronome = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M9 3h6l4 18H5z" /><path d="M12 15l5-8" /></Line>
);
export const IconUndo = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M9 7L4 12l5 5" /><path d="M4 12h11a5 5 0 0 1 0 10h-2" /></Line>
);
export const IconRedo = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M15 7l5 5-5 5" /><path d="M20 12H9a5 5 0 0 0 0 10h2" /></Line>
);
export const IconExport = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M12 4v11" /><path d="M7.5 10.5L12 15l4.5-4.5" /><path d="M5 19h14" /></Line>
);
export const IconFolder = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Line>
);
export const IconPalette = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><circle cx="12" cy="12" r="8.5" /><circle cx="8.5" cy="10" r="1.2" /><circle cx="12" cy="7.5" r="1.2" /><circle cx="15.5" cy="10" r="1.2" /><path d="M12 20.5c-1.5 0-2-1.2-1.4-2.3.7-1.3 1.9-1.7 3.6-1.7h1.8" /></Line>
);
export const IconEditor = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14h18" /><path d="M7 9h4M13 17h4" /></Line>
);
export const IconMixer = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M6 4v16M12 4v16M18 4v16" /><path d="M4 14h4M10 8h4M16 12h4" /></Line>
);
export const IconTuning = ({ size = 16 }: { size?: number }) => (
  <Line size={size}><path d="M3 12c3-6 6 6 9 0s6 6 9 0" /></Line>
);
