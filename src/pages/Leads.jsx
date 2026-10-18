import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../session.jsx';
import { Empty, ErrorNote, PageHead, STAGES, StageTag, ago, inputCls } from '../ui.jsx';

export default function Leads() {
  const [params, setParams] = useSearchParams();
  const stage = params.get('stage') || '';
  const [text, setText] = useState(params.get('q') || '');
  const qs = new URLSearchParams({ ...(stage && { stage }), ...(params.get('q') && { q: params.get('q') }), limit: '200' }).toString();
  const leads = useApi(`/leads?${qs}`);
  const set = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };

  return (
    <>
      <PageHead title="Leads" />
      <div className="mb-4 flex flex-wrap gap-2 items-center">
        <form onSubmit={(e) => { e.preventDefault(); set('q', text.trim()); }} className="flex-1 min-w-56">
          <input type="search" className={inputCls} placeholder="Search name, email, phone, subject…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search leads" />
        </form>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by stage">
          {[['', 'All'], ...STAGES].map(([k, label]) => (
            <button key={k} onClick={() => set('stage', k)} className={`rounded-md px-3 py-1.5 text-sm ${stage === k ? 'bg-ink text-white' : 'bg-white border border-line hover:border-slate'}`}>{label}</button>
          ))}
        </div>
      </div>
      <ErrorNote error={leads.error} />
      {leads.data && !leads.data.length && <Empty title={params.get('q') || stage ? 'No leads match' : 'No leads yet'}>{params.get('q') || stage ? 'Try a different search or stage.' : 'Inquiries from your form will appear here.'}</Empty>}
      {leads.data?.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="text-left text-slate border-b border-line">
              <tr><th className="px-4 py-2.5 font-medium">Family</th><th className="px-4 py-2.5 font-medium">Looking for</th><th className="px-4 py-2.5 font-medium">Stage</th><th className="px-4 py-2.5 font-medium">Received</th><th className="px-4 py-2.5 font-medium">Next</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {leads.data.map((l) => (
                <tr key={l.id} className="hover:bg-paper">
                  <td className="px-4 py-3"><Link to={`/leads/${l.id}`} className="font-medium hover:underline">{l.parent_name || l.email || l.phone}</Link>
                    <span className="block text-xs text-slate">{l.student_name ? `Student: ${l.student_name}` : l.email}</span></td>
                  <td className="px-4 py-3">{[l.subject, l.grade_level].filter(Boolean).join(', ') || <span className="text-slate">—</span>}<span className="block text-xs text-slate">{l.service}</span></td>
                  <td className="px-4 py-3"><StageTag stage={l.stage} /></td>
                  <td className="px-4 py-3 text-slate whitespace-nowrap">{ago(l.created_at)}</td>
                  <td className="px-4 py-3 text-xs">
                    {l.pending_messages > 0 ? <span className="rounded bg-pencil-soft px-2 py-0.5">Reply to review</span>
                      : l.next_appointment ? `Appt ${new Date(l.next_appointment).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                        : <span className="text-slate">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
