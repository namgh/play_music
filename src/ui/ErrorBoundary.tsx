import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { downloadProject, loadAutosave } from '../editor/projectStorage.ts';

/**
 * 예외 하나로 편집기 전체가 사라지지 않게 막는다.
 *
 * React 는 렌더 중 예외가 나면 트리 전체를 언마운트한다 — 화면이 하얗게 되고
 * 사용자는 무슨 일이 났는지 모른 채 작업을 잃는다. 자동 저장이 있어도
 * **그 사실을 알려주지 않으면 소용이 없다.**
 *
 * 그래서 여기서 잡고 (1) 무슨 일인지 말하고 (2) 자동 저장본을 파일로 내려받을
 * 길을 준다. 복구가 최우선이고 원인 파악은 그 다음이다.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 콘솔에도 남긴다 — 사용자가 개발자 도구를 열어 보낼 수 있게
    console.error('편집기에서 예외가 발생했다', error, info.componentStack);
  }

  private rescue = (): void => {
    const project = loadAutosave();
    if (project) downloadProject(project);
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-dvh bg-neutral-950 px-6 py-16 text-neutral-200">
        <div className="mx-auto max-w-xl space-y-5">
          <h1 className="text-xl font-semibold text-white">문제가 생겨 편집기를 멈췄습니다</h1>

          <p className="text-sm/6 text-neutral-400">
            작업은 자동 저장돼 있습니다. 아래에서 파일로 내려받은 뒤 새로고침하면
            이어서 작업할 수 있습니다.
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.rescue}
              className="rounded-md bg-teal-300 px-4 py-2 text-sm font-semibold text-teal-950 hover:bg-teal-200"
            >
              자동 저장본 내려받기
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm"
            >
              새로고침
            </button>
          </div>

          <details className="rounded-lg border border-neutral-800 p-4">
            <summary className="cursor-pointer text-sm text-neutral-400">
              오류 내용 (개발자에게 전달할 때 씁니다)
            </summary>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-neutral-500">
              {error.message}
              {'\n\n'}
              {error.stack}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
