// UTGSU Motion Portal — server-side automation worker
// Runs on a schedule (GitHub Actions) so the timed emails fire WITHOUT anyone
// having the app open. Mirrors the in-app logic exactly:
//   1) Auto-close motions whose 48h voting window expired  -> email results to everyone
//   2) 24h-before-deadline "please vote" reminder           -> email everyone (names non-voters)
//   3) 24h-before-meeting agenda                            -> email everyone the full agenda
//
// Node 20+ (global fetch). No npm install needed.
// Reads config from environment variables (set as GitHub repository secrets).

const ENV = process.env;
const SUPABASE_URL   = ENV.SUPABASE_URL;
const SERVICE_KEY    = ENV.SUPABASE_SERVICE_KEY;          // service-role key (server only!)
const EMAILJS_SERVICE        = ENV.EMAILJS_SERVICE;
const EMAILJS_PUBLIC_KEY     = ENV.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY    = ENV.EMAILJS_PRIVATE_KEY;   // required for server-side send
const EMAILJS_TEMPLATE_PRESIDENT = ENV.EMAILJS_TEMPLATE_PRESIDENT;
const EMAILJS_TEMPLATE_COMMITTEE = ENV.EMAILJS_TEMPLATE_COMMITTEE;
const PORTAL_URL     = ENV.PORTAL_URL || '';
const TZ             = 'America/Toronto';

const VOTE_WINDOW_MS = 48 * 60 * 60 * 1000;
const REMIND_AT_MS   = 24 * 60 * 60 * 1000;
const AGENDA_LEAD_MS = 24 * 60 * 60 * 1000;

// ---- people (must match the app) ----
const VOTERS = [
  { key:'president', role:'President',    name:'Amir Moghadam',      email:'president@utgsu.ca' },
  { key:'external',  role:'VP External',  name:'Nick Silver',        email:'external@utgsu.ca' },
  { key:'internal',  role:'VP Internal',  name:'Reke Avikpe',        email:'internal@utgsu.ca' },
  { key:'finance',   role:'VP Finance',   name:'Amirhossein Zadeh',  email:'finance@utgsu.ca' },
  { key:'gradlife',  role:'VP Grad Life', name:'Zoe Nicholadis',     email:'gradlife@utgsu.ca' },
  { key:'academics', role:'VP Academics', name:'Eliz Shimshek',      email:'academics@utgsu.ca' },
];
const EXECDIR = { key:'execdir', role:'Executive Director', name:'Corey Scott', email:'executivedirector@utgsu.ca' };
const ALL_RECIPIENTS = [...VOTERS.map(v=>v.email), EXECDIR.email];
const EXEC_NAMES = VOTERS.map(v=>v.name);
const STAFF = [
  { name:'Susana May Boateng', role:'Union Affairs and Services Coordinator' },
  { name:'Corey Scott', role:'Executive Director' },
  { name:'Shain Abdulla', role:'Communications and Engagement Specialist' },
  { name:'Gail Fernando', role:'Finance Administrator' },
  { name:'Nusrat Huq', role:'Membership & Advocacy Coordinator' },
  { name:'Lorena Florea', role:'Health and Dental Plan Administrator' },
];
const STAFF_NAMES = STAFF.map(s=>s.name);
const REPORT_ROLES = [
  'President','Vice President External','Vice President Internal','Vice President Finance','Vice President Grad Life','Vice President Academics',
  'Executive Director','Health and Dental Plan Administrator','Finance Administrator','Membership & Advocacy Coordinator','Communications and Engagement Specialist','Union Affairs and Services Coordinator'
];
const CHOICE = { yes:{label:'Yes'}, no:{label:'No'}, abstain:{label:'Abstain'} };

// ---- helpers (match the app) ----
const fmt = (ts) => { try { return new Date(ts).toLocaleString('en-CA',{ timeZone:TZ, month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }); } catch { return ''; } };
const fmtMeetingDate  = (m) => { try { return new Date(m.date).toLocaleDateString('en-CA',{ timeZone:TZ, weekday:'long', year:'numeric', month:'long', day:'numeric' }); } catch { return ''; } };
const fmtMeetingShort = (m) => { try { return new Date(m.date).toLocaleDateString('en-CA',{ timeZone:TZ, month:'long', day:'numeric', year:'numeric' }); } catch { return ''; } };
const surname = (name) => { if(!name) return ''; const p=String(name).trim().split(/\s+/); return p[p.length-1]; };
const voterLabel = (key) => { const v=VOTERS.find(x=>x.key===key); return v?v.name:key; };
const isEdMover = (m) => !!(m && m.mover && String(m.mover).trim().toLowerCase()===EXECDIR.name.trim().toLowerCase());
const moverDisplay = (m) => isEdMover(m) ? ('To be set on first vote (submitted by '+EXECDIR.name+', Exec Director)') : (m ? m.mover : '');
const motionMoverName = (m) => isEdMover(m) ? '—' : (m.mover||'—');
const motionSeconderName = (m) => m.seconder ? voterLabel(m.seconder) : '—';
const tally = (m) => { const c={yes:0,no:0,abstain:0}; Object.values(m.votes||{}).forEach(v=>{ if(c[v.choice]!=null) c[v.choice]++; }); return c; };
const isPassed = (m) => { const t=tally(m); return t.yes > t.no; }; // simple majority, abstentions excluded
const votedCount = (m) => Object.keys(m.votes||{}).length;
const meetingTime = (m) => (m && m.date) ? new Date(m.date).getTime() : 0;
const expiresAt = (m) => (m && m.status==='voting' && m.approvedAt) ? new Date(m.approvedAt).getTime()+VOTE_WINDOW_MS : null;

// ---- Supabase REST (service role, bypasses RLS) ----
async function sbGet(table){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, { headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}` } });
  if(!r.ok) throw new Error(`GET ${table} ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbPatch(table, id, patch){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method:'PATCH',
    headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`, 'Content-Type':'application/json', Prefer:'return=minimal' },
    body: JSON.stringify(patch),
  });
  if(!r.ok) throw new Error(`PATCH ${table} ${r.status} ${await r.text()}`);
}

// row -> app shape
const rowToMotion  = (r) => ({ id:r.id, title:r.title, mover:r.mover, category:r.category, motionText:r.motion_text, background:r.background, link:r.link, status:r.status, seconder:r.seconder, votes:r.votes||{}, meetingId:r.meeting_id||null, pendingMeeting:r.pending_meeting||false, reminderSent:r.reminder_sent||false, createdAt:r.created_at, approvedAt:r.approved_at, closedAt:r.closed_at, closeReason:r.close_reason });
const rowToMeeting = (r) => ({ id:r.id, title:r.title, date:r.meeting_date, timeLabel:r.time_label, location:r.location, chair:r.chair, status:r.status, attendance:r.attendance||{}, reports:r.reports||{}, minutes:r.minutes||{}, agendaSentAt:r.agenda_sent_at, publishedAt:r.published_at });
const rowToItem    = (r) => ({ id:r.id, meetingId:r.meeting_id, position:r.position, title:r.title, presenter:r.presenter, type:r.type, timeEstimate:r.time_estimate, description:r.description, motionText:r.motion_text, docs:r.docs, mover:r.mover, seconder:r.seconder, result:r.result, notes:r.notes, linkedMotionId:r.linked_motion_id });

// ---- EmailJS REST send (server-side; requires private key + "non-browser" enabled) ----
async function sendEmail(e, ALL_MOTIONS){
  const tmpl = e.kind==='vote' ? EMAILJS_TEMPLATE_COMMITTEE : EMAILJS_TEMPLATE_PRESIDENT;
  const subject = e.subject, message = emailToText(e);
  let ok = true;
  for(const to of e.to){
    try {
      const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({
          service_id: EMAILJS_SERVICE, template_id: tmpl,
          user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY,
          template_params:{ to_email:to, subject, message, motion_title:e.motionTitle },
        }),
      });
      if(!r.ok){ ok=false; console.error('EmailJS send failed', r.status, await r.text()); }
    } catch(err){ ok=false; console.error('EmailJS error', err); }
  }
  return ok;
}
function emailToText(e){
  const L=[];
  if(e.intro) L.push(e.intro);
  L.push('');
  L.push('MOTION: '+e.motionTitle);
  if(e.hasTally){ L.push('RESULT: '+(e.passed?'PASSED':'FAILED')); L.push('Yes '+e.yes+'   No '+e.no+'   Abstain '+e.abstain); }
  L.push('');
  (e.fields||[]).forEach(f=>{ if(f.value){ L.push(f.label+':'); L.push(f.value); L.push(''); } });
  if(PORTAL_URL){ L.push((e.kind==='vote'?'Vote here: ':'Open the portal: ')+PORTAL_URL); L.push(''); }
  if(e.note) L.push(e.note);
  return L.join('\n');
}

// ---- email builders (match the app) ----
const motionFields = (m) => {
  const f=[ {label:'Category', value:m.category}, {label:'Mover', value:moverDisplay(m)}, {label:'Motion text', value:m.motionText}, {label:'Background', value:m.background} ];
  if(m.link) f.push({label:'Supporting document', value:m.link});
  return f;
};
function buildResultsEmail(m){
  const t=tally(m), passed=isPassed(m);
  const lines = VOTERS.map(v=>{ const vote=m.votes[v.key]; return v.name+' ('+v.role+'): '+(vote? CHOICE[vote.choice].label+' — signed '+vote.signature : 'did not vote'); }).join('\n');
  let how='all members have voted';
  if(m.closeReason==='early') how='closed early by the President';
  else if(m.closeReason==='expired') how='the 48-hour voting window expired';
  return { kind:'results', to:ALL_RECIPIENTS, subject:'Results: '+m.title+' — '+(passed?'PASSED':'FAILED'),
    intro:'Voting has closed because '+how+'. The motion has '+(passed?'PASSED':'FAILED')+'. Final results are below.',
    motionTitle:m.title, hasTally:true, yes:t.yes, no:t.no, abstain:t.abstain, passed,
    fields:[ {label:'Mover', value:m.mover}, {label:'Seconder', value:m.seconder? voterLabel(m.seconder):'—'}, {label:'Roster', value:lines} ],
    note:'Decided by simple majority of Yes vs No; abstentions are excluded.' };
}
function buildReminderEmail(m){
  const e=expiresAt(m);
  const notVoted=VOTERS.filter(v=>!m.votes[v.key]);
  const voted=VOTERS.filter(v=>m.votes[v.key]);
  return { kind:'reminder', to:ALL_RECIPIENTS, subject:'⏰ Reminder — 24 hours left to vote: '+m.title,
    intro:'This is a reminder to cast your vote. Voting on the motion below closes in 24 hours, on '+fmt(e)+'. After that the vote closes automatically and the result is finalized from the votes received.',
    motionTitle:m.title,
    fields:[
      {label:'Still need to vote ('+notVoted.length+')', value:notVoted.map(v=>v.role+' ('+v.email+')').join(', ')||'—'},
      {label:'Already voted ('+voted.length+')', value:voted.map(v=>v.role).join(', ')||'none yet'},
      {label:'Mover', value:moverDisplay(m)},
      {label:'Motion text', value:m.motionText},
      {label:'Background', value:m.background},
      ...(m.link?[{label:'Supporting document', value:m.link}]:[]),
    ],
    note:'Please open the Motion Portal to cast your vote (Yes / No / Abstain) and sign. If you have already voted, no action is needed. The Executive Director receives this for the record and does not vote.' };
}
function buildAgendaEmail(m, ctx){
  return { kind:'vote', to:ALL_RECIPIENTS, subject:'Agenda — '+m.title+', '+fmtMeetingShort(m),
    motionTitle:m.title,
    intro:'The agenda for the upcoming '+m.title+' is now set. The meeting is '+fmtMeetingDate(m)+(m.timeLabel?', '+m.timeLabel:'')+(m.location?', '+m.location:'')+'.\n\nThe full agenda follows. Open the portal to download the agenda document (.docx), add your report, or review items.',
    fields:[{label:'Agenda', value:agendaPlainText(m, ctx)}],
    note:'This agenda was sent automatically 24 hours before the meeting.' };
}

// ---- agenda model / text (match the app) ----
function itemsFor(meetingId, ctx){ return ctx.items.filter(i=>i.meetingId===meetingId).sort((a,b)=>a.position-b.position); }
function prevMeetingTime(meeting, ctx){ const t=meetingTime(meeting); const earlier=ctx.meetings.filter(x=>x.id!==meeting.id && meetingTime(x)<t); return earlier.length?Math.max(...earlier.map(x=>meetingTime(x))):0; }
function previousMeeting(meeting, ctx){ const t=meetingTime(meeting); const earlier=ctx.meetings.filter(x=>x.id!==meeting.id && meetingTime(x)<t).sort((a,b)=>meetingTime(b)-meetingTime(a)); return earlier[0]||null; }
function digitalMotionsFor(meeting, ctx){
  const t=meetingTime(meeting), prev=prevMeetingTime(meeting, ctx);
  return ctx.motions.filter(mo=>{ if(mo.meetingId) return false; if(mo.status!=='closed' || !mo.closedAt) return false; const ct=new Date(mo.closedAt).getTime(); return ct>prev && ct<=t; })
    .sort((a,b)=>new Date(a.closedAt)-new Date(b.closedAt));
}
function agendaModel(m, ctx){
  const items=itemsFor(m.id, ctx), digital=digitalMotionsFor(m, ctx), prev=previousMeeting(m, ctx), mn=m.minutes||{};
  const sn=(name)=>surname(name)||'____________';
  const secs=[];
  secs.push({ n:'1', title:'Call to Order', lines:['The meeting is called to order'+(mn.callToOrder?' at '+mn.callToOrder:' at __________')+'.'] });
  secs.push({ n:'2', title:'Adoption of Agenda', motion:{ birt:'BIRT, the Executive Committee adopts the agenda for the '+fmtMeetingShort(m)+', UTGSU Office Meeting.', mover:sn(mn.adoption&&mn.adoption.mover), seconder:sn(mn.adoption&&mn.adoption.seconder), result:(mn.adoption&&mn.adoption.result)||'____________' } });
  secs.push({ n:'3', title:'Approval of Minutes', motion:{ birt:'BIRT, the Executive Committee approves the minutes from the '+(mn.prevMinutesDate||(prev?fmtMeetingShort(prev):'previous'))+' UTGSU Office Meeting.', mover:sn(mn.approval&&mn.approval.mover), seconder:sn(mn.approval&&mn.approval.seconder), result:(mn.approval&&mn.approval.result)||'____________' } });
  if(digital.length){ secs.push({ n:'4', title:'Notice of Digital Motions', digital:digital.map(mo=>({ served:'The following motion was served online and '+(isPassed(mo)?'passed':'failed')+' on '+fmt(mo.closedAt)+'.', birt:mo.motionText, mover:surname(motionMoverName(mo)), seconder:surname(motionSeconderName(mo)), result:isPassed(mo)?'Carries':'Fails' })) }); }
  let n = digital.length ? 5 : 4;
  items.forEach(it=>{ const lines=[]; if(it.description) lines.push(it.description); if(it.notes) lines.push(it.notes);
    secs.push({ n:String(n++), title:it.title, meta:[it.presenter?('Presenter: '+it.presenter):'', it.timeEstimate?('Time: '+it.timeEstimate):'', it.type==='decision'?'Decision':'Discussion'].filter(Boolean).join('  ·  '), lines, motion: it.type==='decision' && it.motionText ? { birt:it.motionText, mover:sn(it.mover), seconder:sn(it.seconder), result:it.result||'____________' } : null }); });
  const mtgMotions=ctx.motions.filter(mo=>mo.meetingId===m.id);
  if(mtgMotions.length){ secs.push({ n:String(n++), title:'Motions', digital:mtgMotions.map(mo=>({ served:'Motion brought to this meeting'+(mo.status==='closed'?', '+(isPassed(mo)?'passed':'failed')+' '+fmt(mo.closedAt):(mo.status==='voting'?' — voting in progress':'')), birt:mo.motionText, mover:surname(motionMoverName(mo)), seconder:surname(motionSeconderName(mo)), result: mo.status==='closed' ? (isPassed(mo)?'Carries':'Fails') : (mo.status==='voting'?'In progress':'Pending') })) }); }
  secs.push({ n:String(n++), title:'Other Business', lines:[mn.otherBusiness||''] });
  secs.push({ n:String(n++), title:'Executive & Staff Reports', reports:REPORT_ROLES.map(role=>({ role, text:(m.reports&&m.reports[role])||'' })) });
  secs.push({ n:String(n++), title:'Adjournment', lines:['The meeting is adjourned'+(mn.adjourn?' at '+mn.adjourn:' at __________')+'.'] });
  return secs;
}
function agendaPlainText(m, ctx){
  const L=[];
  agendaModel(m, ctx).forEach(s=>{
    L.push(s.n+'. '+s.title);
    if(s.meta) L.push('   '+s.meta);
    (s.lines||[]).forEach(x=>{ if(x) L.push('   '+x); });
    if(s.motion){ L.push('   MOTION: '+s.motion.birt); }
    if(s.digital){ s.digital.forEach(d=>{ L.push('   '+d.served); L.push('   MOTION: '+d.birt); L.push('   Mover: '+d.mover+'   Seconder: '+d.seconder+'   Result: '+d.result); }); }
    if(s.reports){ s.reports.forEach(r=>{ L.push('   '+r.role+(r.text?':':'')); if(r.text) L.push('      '+r.text); }); }
    L.push('');
  });
  return L.join('\n');
}

// ---- main ----
async function main(){
  const missing=['SUPABASE_URL','SUPABASE_SERVICE_KEY','EMAILJS_SERVICE','EMAILJS_PUBLIC_KEY','EMAILJS_PRIVATE_KEY','EMAILJS_TEMPLATE_PRESIDENT','EMAILJS_TEMPLATE_COMMITTEE'].filter(k=>!ENV[k]);
  if(missing.length){ console.error('Missing env vars:', missing.join(', ')); process.exit(1); }

  const motions  = (await sbGet('motions')).map(rowToMotion);
  const meetings  = (await sbGet('meetings')).map(rowToMeeting);
  const items     = (await sbGet('agenda_items')).map(rowToItem);
  const ctx = { motions, meetings, items };
  const now = Date.now();
  let actions = 0;

  // 1) Auto-close expired voting motions, then email results
  for(const m of motions){
    const e = expiresAt(m);
    if(m.status==='voting' && e!=null && now>=e){
      await sbPatch('motions', m.id, { status:'closed', closed_at:new Date(now).toISOString(), close_reason:'expired' });
      const closed = { ...m, status:'closed', closedAt:new Date(now).toISOString(), closeReason:'expired' };
      m.status='closed'; m.closedAt=closed.closedAt; m.closeReason='expired'; // reflect in ctx for agenda
      await sendEmail(buildResultsEmail(closed), motions);
      console.log('Closed + results emailed:', m.title);
      actions++;
    }
  }

  // 2) 24h "please vote" reminder (once per motion)
  for(const m of motions){
    if(m.status!=='voting' || !m.approvedAt || m.reminderSent) continue;
    const e = expiresAt(m); if(e==null) continue;
    const remaining = e - now;
    if(remaining>REMIND_AT_MS || remaining<=0) continue;
    if(votedCount(m) >= VOTERS.length) continue;
    await sbPatch('motions', m.id, { reminder_sent:true });
    await sendEmail(buildReminderEmail(m), motions);
    console.log('Reminder emailed:', m.title);
    actions++;
  }

  // 3) 24h-before-meeting agenda (once per meeting)
  for(const m of meetings){
    if(m.status==='completed' || m.agendaSentAt) continue;
    const send = meetingTime(m) - AGENDA_LEAD_MS;
    if(send>0 && now>=send && now<meetingTime(m)){
      await sbPatch('meetings', m.id, { agenda_sent_at:new Date(now).toISOString(), status:(m.status==='planning'?'published':m.status), published_at:m.publishedAt||new Date(now).toISOString() });
      await sendEmail(buildAgendaEmail(m, ctx), motions);
      console.log('Agenda emailed:', m.title, fmtMeetingShort(m));
      actions++;
    }
  }

  console.log(`Done. ${actions} action(s) at ${fmt(now)} (${TZ}).`);
}
main().catch(err=>{ console.error(err); process.exit(1); });
