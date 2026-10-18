import { Link } from 'react-router-dom';
import { useApi } from '../session.jsx';
import { Empty, ErrorNote, PageHead, StageTag, ago } from '../ui.jsx';
import MessageReview from './MessageReview.jsx';

export default function Queue() {
  const q = useApi('/queue');
  return (
    <>
      <PageHead title="Review queue" sub="Nothing is sent to a family until someone here approves it." />
      <ErrorNote error={q.error} />
      {q.data && !q.data.length && <Empty title="Nothing to review">New replies and scheduled follow-ups will appear here.</Empty>}
      <div className="space-y-8">
        {q.data?.map((m) => (
          <div key={m.id} className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <aside className="text-sm">
              <Link to={`/leads/${m.lead_id}`} className="font-display text-lg font-bold hover:underline">{m.parent_name || m.email}</Link>
              <p className="text-slate">{m.email || 'No email on file'}</p>
              <div className="mt-2"><StageTag stage={m.stage} /></div>
              <p className="mt-2">{[m.lead_subject, m.grade_level, m.service].filter(Boolean).join(', ') || 'Not classified'}</p>
              <blockquote className="mt-3 border-l-2 border-line pl-3 text-slate whitespace-pre-line line-clamp-[10]">{m.inquiry}</blockquote>
              <p className="mt-2 text-xs text-slate">Drafted {ago(m.created_at)}</p>
            </aside>
            <MessageReview msg={m} to={m.email} onDone={q.reload} />
          </div>
        ))}
      </div>
    </>
  );
}
