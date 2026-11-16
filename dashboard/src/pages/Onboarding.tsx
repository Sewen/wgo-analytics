import { useState } from 'react';
import { ArrowRight, Check, Radio, Rocket } from 'lucide-react';
import { useCreateProject } from '../api/hooks';
import type { Project } from '../api/contract';
import { LogoMark } from '../ui/Logo';
import { Button, Card } from '../ui/kit';
import { Install } from './Install';
import { LiveProvider } from '../live/LiveProvider';
import { useFirehose, useLive } from '../live/store';

function Waiting({ onDone }: { project: Project; onDone: () => void }) {
  const live = useLive();
  useFirehose(true);
  const got = live.eventsSeen > 0;
  const last = live.feed[0]?.ev;
  return (
    <Card className={`flex items-center justify-between gap-4 p-4 transition-colors ${got ? 'border-good/50' : ''}`}>
      <div className="flex items-center gap-3">
        <span className={`relative grid h-9 w-9 place-items-center rounded-full ${got ? 'bg-good/15 text-good' : 'bg-[var(--hl)] text-muted'}`}>
          {got ? <Check size={18} /> : <Radio size={17} />}
          {!got && <i className="absolute inset-0 rounded-full border border-accent2/50 pulse-dot" />}
        </span>
        <div>
          <div className="text-[13.5px] font-medium">{got ? 'First event received!' : 'Waiting for first event…'}</div>
          <div className="text-[12px] text-muted">{got ? `${last?.type ?? 'event'} ${last?.path ?? last?.selector ?? ''} · ${live.eventsSeen} so far` : `Live connection: ${live.status}. Load a page with the snippet installed.`}</div>
        </div>
      </div>
      <Button variant={got ? 'primary' : 'secondary'} onClick={onDone}>{got ? 'Open dashboard' : 'Skip for now'}<ArrowRight size={15} /></Button>
    </Card>
  );
}

export function Onboarding({ first, onBack, project, setProject, onDone }: { first: boolean; onBack?: () => void; project: Project | null; setProject: (p: Project | null) => void; onDone: (p: Project) => void }) {
  const [name, setName] = useState('');
  const create = useCreateProject();
  return (
    <div className="bg-atmos min-h-full overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-6 py-14">
        <div className="mb-10 flex items-center justify-between"><div className="flex items-center gap-2.5"><LogoMark size={30} /><span className="text-[17px] font-semibold">WGO</span></div>
          {!first && !project && <Button variant="ghost" onClick={onBack}>Cancel</Button>}</div>
        {!project ? (
          <div className="anim-pop">
            <div className="mb-5 inline-grid h-12 w-12 place-items-center rounded-2xl grad-bg text-white"><Rocket size={22} /></div>
            <h1 className="text-[30px] font-semibold tracking-tight">{first ? <>Create your <span className="grad-text">first project</span></> : 'Create a new project'}</h1>
            <p className="mt-2 text-[14px] text-muted">A project is one site or app. You will get a write key and ready-to-paste snippets in a moment.</p>
            <form className="mt-8 flex gap-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name.trim(), { onSuccess: setProject }); }}>
              <input autoFocus className="field !py-2.5 text-[14px]" placeholder="e.g. Acme storefront" value={name} onChange={(e) => setName(e.target.value)} />
              <Button variant="primary" className="!px-5" disabled={!name.trim() || create.isPending}>{create.isPending ? 'Creating…' : 'Create project'}</Button>
            </form>
            {create.isError && <p className="mt-3 text-[13px] text-bad">{(create.error as Error).message}</p>}
          </div>
        ) : (
          <LiveProvider pid={project.id}>
            <div className="anim-pop space-y-6">
              <div><h1 className="text-[26px] font-semibold tracking-tight">Install <span className="grad-text">{project.name}</span></h1>
                <p className="mt-1.5 text-[14px] text-muted">Add the snippet to your site. We will light up as soon as an event arrives.</p></div>
              <Waiting project={project} onDone={() => onDone(project)} />
              <Card className="p-5"><Install project={project} /></Card>
            </div>
          </LiveProvider>
        )}
      </div>
    </div>
  );
}
