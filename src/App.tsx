import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Shield, ShieldCheck, ShieldX, Chrome, Zap, Brain,
  LogIn, LogOut, Trash2, Clock, AlertTriangle, CheckCircle,
  Eye, Lock, FileText, Cpu, ArrowRight, Star,
} from 'lucide-react';
import { auth, db, signIn, signOut } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, where, orderBy, onSnapshot, deleteDoc, doc, Timestamp } from 'firebase/firestore';

// ── Types ─────────────────────────────────────────────────────────────────────

type Page = 'landing' | 'history';

interface ScanRecord {
  id: string;
  rating: 'SAFE' | 'OKAY' | 'RISKY';
  score: number;
  tldr: string;
  url: string;
  createdAt: Timestamp;
  tier: 'quick' | 'deep';
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const rating = {
  SAFE: {
    bg: 'bg-emerald-500/[0.08]',
    border: 'border-emerald-500/20',
    text: 'text-emerald-400',
    badge: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20',
    glow: 'shadow-emerald-500/10',
    pill: 'bg-emerald-400',
  },
  OKAY: {
    bg: 'bg-amber-500/[0.08]',
    border: 'border-amber-500/20',
    text: 'text-amber-400',
    badge: 'bg-amber-500/15 text-amber-300 border border-amber-500/20',
    glow: 'shadow-amber-500/10',
    pill: 'bg-amber-400',
  },
  RISKY: {
    bg: 'bg-rose-500/[0.08]',
    border: 'border-rose-500/20',
    text: 'text-rose-400',
    badge: 'bg-rose-500/15 text-rose-300 border border-rose-500/20',
    glow: 'shadow-rose-500/10',
    pill: 'bg-rose-400',
  },
};

function timeAgo(ts: Timestamp): string {
  const diff = Date.now() - ts.toMillis();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

// ── Score Ring ────────────────────────────────────────────────────────────────

function ScoreRing({ score, r = 'RISKY' }: { score: number; r: 'SAFE' | 'OKAY' | 'RISKY' }) {
  const radius = 20;
  const circ = 2 * Math.PI * radius;
  const fill = ((100 - score) / 100) * circ;
  const color = r === 'SAFE' ? '#34d399' : r === 'OKAY' ? '#fbbf24' : '#f87171';
  return (
    <svg width="52" height="52" className="rotate-[-90deg]">
      <circle cx="26" cy="26" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="3" />
      <circle cx="26" cy="26" r={radius} fill="none" stroke={color} strokeWidth="3"
        strokeDasharray={circ} strokeDashoffset={fill} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      <text x="26" y="26" textAnchor="middle" dominantBaseline="central"
        fill={color} fontSize="11" fontWeight="800"
        style={{ transform: 'rotate(90deg)', transformOrigin: '26px 26px' }}>
        {score}
      </text>
    </svg>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────

function Nav({ page, onNav, user, onSignIn, onSignOut }: {
  page: Page; onNav: (p: Page) => void;
  user: User | null; onSignIn: () => void; onSignOut: () => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 12);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  return (
    <nav className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
      scrolled ? 'bg-[#080b14]/90 backdrop-blur-2xl border-b border-white/[0.05] shadow-xl shadow-black/30' : 'bg-transparent'
    }`}>
      <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-16">
        {/* Logo */}
        <button onClick={() => onNav('landing')} className="flex items-center gap-2.5">
          <div className="relative w-8 h-8 rounded-[10px] bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <span className="font-black text-white text-[15px] tracking-[-0.02em]">TLDR Shield</span>
        </button>

        {/* Right */}
        <div className="flex items-center gap-2">
          {user && (
            <button onClick={() => onNav('history')}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold transition-all duration-200 ${
                page === 'history'
                  ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/20'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'
              }`}>
              <Clock className="w-3.5 h-3.5" />History
            </button>
          )}

          {user ? (
            <div className="flex items-center gap-2 pl-2 border-l border-white/[0.08]">
              {user.photoURL && <img src={user.photoURL} alt="" className="w-7 h-7 rounded-full ring-1 ring-white/20" />}
              <span className="text-[13px] text-slate-400 font-medium hidden sm:block">
                {user.displayName?.split(' ')[0]}
              </span>
              <button onClick={onSignOut}
                className="p-2 rounded-xl text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-all">
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button onClick={onSignIn}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold text-white bg-white/[0.07] hover:bg-white/[0.12] border border-white/[0.08] transition-all">
              <LogIn className="w-3.5 h-3.5" />Sign in
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}

// ── Landing ───────────────────────────────────────────────────────────────────

const FEATURES = [
  { icon: Zap, color: 'text-amber-400', bg: 'from-amber-500/10 to-amber-500/[0.03]', border: 'border-amber-500/15', title: 'Quick Scan', desc: 'Instant SAFE / OKAY / RISKY verdict in ~4 seconds. AI reads it so you don\'t have to.' },
  { icon: Brain, color: 'text-violet-400', bg: 'from-violet-500/10 to-violet-500/[0.03]', border: 'border-violet-500/15', title: 'Deep Scan', desc: 'Full clause-by-clause breakdown with verbatim citations across 6 privacy pillars.' },
  { icon: Eye, color: 'text-sky-400', bg: 'from-sky-500/10 to-sky-500/[0.03]', border: 'border-sky-500/15', title: 'Auto-Detect', desc: 'Detects T&C pages as you browse using URL, headings, and modal signals.' },
  { icon: Lock, color: 'text-rose-400', bg: 'from-rose-500/10 to-rose-500/[0.03]', border: 'border-rose-500/15', title: 'Dark Patterns', desc: 'Catches forced arbitration, class-action waivers, and buried opt-outs.' },
  { icon: FileText, color: 'text-emerald-400', bg: 'from-emerald-500/10 to-emerald-500/[0.03]', border: 'border-emerald-500/15', title: 'Long Doc Support', desc: 'Splits massive T&C into blocks, analyzes in parallel, aggregates into one verdict.' },
  { icon: Cpu, color: 'text-indigo-400', bg: 'from-indigo-500/10 to-indigo-500/[0.03]', border: 'border-indigo-500/15', title: 'Powered by LLaMA', desc: 'meta/llama-3.3-70b — a 98+/100 accuracy privacy model via NVIDIA NIM.' },
];

const PILLARS_DEMO = [
  { label: 'AI Training', violation: true },
  { label: 'Data Selling', violation: true },
  { label: 'Transparency', violation: false },
  { label: 'Data Retention', violation: true },
  { label: 'Ownership', violation: true },
  { label: 'Dark Patterns', violation: true },
];

const STEPS = [
  { n: '01', title: 'Install the Extension', desc: 'One click from the Chrome Web Store. No account required.' },
  { n: '02', title: 'Browse Normally', desc: 'TLDR Shield auto-detects T&C pages and shows a floating badge.' },
  { n: '03', title: 'Get Your Verdict', desc: 'See SAFE, OKAY, or RISKY with a plain-English explanation instantly.' },
];

function LandingPage({ onSignIn, user, onNav }: { onSignIn: () => void; user: User | null; onNav: (p: Page) => void }) {
  return (
    <div className="min-h-screen bg-[#080b14] text-white overflow-x-hidden">

      {/* Background orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[600px] bg-indigo-600/[0.07] rounded-full blur-[120px]" />
        <div className="absolute top-[60vh] -left-40 w-[500px] h-[500px] bg-violet-600/[0.05] rounded-full blur-[100px]" />
        <div className="absolute top-[40vh] -right-40 w-[400px] h-[400px] bg-indigo-500/[0.04] rounded-full blur-[100px]" />
      </div>

      {/* ── Hero ── */}
      <section className="relative pt-44 pb-24 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>

            {/* Eyebrow */}
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-semibold tracking-wider uppercase mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
              AI-Powered Privacy Protection
            </div>

            {/* Headline */}
            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-black tracking-[-0.04em] leading-[0.92] mb-6">
              Stop agreeing to things
              <br />
              <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-purple-500 bg-clip-text text-transparent">
                you haven't read.
              </span>
            </h1>

            <p className="text-lg text-slate-400 max-w-lg mx-auto leading-relaxed mb-10">
              TLDR Shield scans Terms & Conditions and Privacy Policies in seconds —
              giving you a clear verdict before you click <em className="text-slate-300 not-italic">"I Agree"</em>.
            </p>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <a href="https://chrome.google.com/webstore" target="_blank" rel="noopener noreferrer"
                className="group flex items-center gap-3 px-7 py-3.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 rounded-2xl font-bold text-[15px] transition-all duration-300 shadow-2xl shadow-indigo-500/20 hover:shadow-indigo-500/30 hover:-translate-y-0.5">
                <Chrome className="w-5 h-5" />
                Add to Chrome — Free
                <ArrowRight className="w-4 h-4 opacity-60 group-hover:translate-x-0.5 transition-transform" />
              </a>

              {user ? (
                <button onClick={() => onNav('history')}
                  className="flex items-center gap-2 px-7 py-3.5 rounded-2xl font-bold text-[15px] text-slate-300 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] hover:border-white/[0.14] transition-all">
                  <Clock className="w-4 h-4 opacity-70" />
                  View Scan History
                </button>
              ) : (
                <button onClick={onSignIn}
                  className="flex items-center gap-2 px-7 py-3.5 rounded-2xl font-bold text-[15px] text-slate-300 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] hover:border-white/[0.14] transition-all">
                  <LogIn className="w-4 h-4 opacity-70" />
                  Save Scan History
                </button>
              )}
            </div>

            {/* Social proof */}
            <div className="flex items-center justify-center gap-5 mt-8 text-slate-600 text-xs font-medium">
              <span className="flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-emerald-500/70" />No account required</span>
              <span className="w-px h-3 bg-white/10" />
              <span className="flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-emerald-500/70" />Free forever</span>
              <span className="w-px h-3 bg-white/10" />
              <span className="flex items-center gap-1.5"><Star className="w-3.5 h-3.5 text-amber-500/70" />98+ accuracy</span>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Extension Preview ── */}
      <section className="pb-28 px-6 flex justify-center">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="relative"
        >
          {/* Glow behind card */}
          <div className="absolute inset-0 -m-6 bg-gradient-radial from-rose-500/10 via-transparent to-transparent blur-2xl" />

          {/* Card */}
          <div className="relative w-[320px] rounded-[22px] bg-[#0e1220] border border-white/[0.07] shadow-2xl shadow-black/60 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.05]">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
                  <Shield className="w-3 h-3 text-white" />
                </div>
                <span className="text-indigo-300 font-black text-xs tracking-[0.12em] uppercase">TLDR Shield</span>
              </div>
              <button className="w-6 h-6 rounded-lg bg-white/[0.05] flex items-center justify-center text-slate-500 hover:text-slate-300 text-xs transition-colors">✕</button>
            </div>

            {/* Badge */}
            <div className="mx-4 mt-4 p-4 rounded-[14px] bg-rose-500/[0.08] border border-rose-500/20 text-center">
              <div className="flex items-center justify-center gap-3 mb-1">
                <ShieldX className="w-5 h-5 text-rose-400" />
                <span className="text-rose-300 font-black text-xl tracking-widest">RISKY</span>
              </div>
              <div className="text-4xl font-black text-rose-300 mb-1">5<span className="text-xl text-rose-400/50">/100</span></div>
              <div className="text-rose-400/50 text-[11px] font-semibold tracking-wider">🔬 DEEP SCAN · MEGACORP INC.</div>
            </div>

            {/* TL;DR */}
            <div className="mx-4 my-3 p-3 bg-white/[0.03] rounded-xl border border-white/[0.04]">
              <p className="text-slate-400 text-[11px] leading-relaxed italic">
                "Grants perpetual rights to your content, shares data with 847 partners, retains data for 10 years post-deletion, and waives class-action rights."
              </p>
            </div>

            {/* Pillars */}
            <div className="px-4 pb-4 flex flex-col gap-1">
              {PILLARS_DEMO.map(p => (
                <div key={p.label} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.025] hover:bg-white/[0.04] transition-colors">
                  <span className="text-slate-400 text-[11px] font-semibold uppercase tracking-[0.07em]">{p.label}</span>
                  <span className={`text-[10px] font-black px-2.5 py-0.5 rounded-full tracking-wider ${
                    p.violation ? 'bg-rose-500/15 text-rose-300 border border-rose-500/20' : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20'
                  }`}>
                    {p.violation ? 'VIOLATION' : 'CLEAR'}
                  </span>
                </div>
              ))}
            </div>

            {/* Deep scan btn */}
            <div className="px-4 pb-4">
              <div className="p-3 rounded-xl bg-indigo-500/[0.07] border border-indigo-500/15 text-center">
                <p className="text-indigo-300/70 text-[11px] mb-2">Want full clause breakdown & citations?</p>
                <div className="inline-flex items-center gap-1.5 text-indigo-300 text-xs font-bold">🔬 Run Deep Scan</div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 pb-3 text-center text-slate-700 text-[9px] uppercase tracking-[0.15em] border-t border-white/[0.04] pt-3">
              TL;DR Shield · Privacy Analysis
            </div>
          </div>
        </motion.div>
      </section>

      {/* ── How it works ── */}
      <section className="pb-28 px-6 max-w-4xl mx-auto">
        <div className="text-center mb-16">
          <p className="text-indigo-400 text-xs font-semibold tracking-[0.15em] uppercase mb-3">How it works</p>
          <h2 className="text-3xl font-black tracking-[-0.03em]">Three steps to privacy clarity</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
          {/* Connector line */}
          <div className="hidden md:block absolute top-7 left-[20%] right-[20%] h-px bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent" />
          {STEPS.map((s, i) => (
            <motion.div key={s.n} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 * i }}
              className="relative flex flex-col items-center text-center p-6">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-500/10 border border-indigo-500/20 flex items-center justify-center mb-5 text-indigo-300 font-black text-sm tracking-wider">
                {s.n}
              </div>
              <h3 className="font-bold text-white mb-2 text-[15px]">{s.title}</h3>
              <p className="text-slate-500 text-sm leading-relaxed">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section className="pb-28 px-6 max-w-5xl mx-auto">
        <div className="text-center mb-16">
          <p className="text-indigo-400 text-xs font-semibold tracking-[0.15em] uppercase mb-3">Features</p>
          <h2 className="text-3xl font-black tracking-[-0.03em]">Everything you need to browse safely</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f, i) => (
            <motion.div key={f.title} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.07 * i }}
              className={`group p-5 rounded-2xl bg-gradient-to-br ${f.bg} border ${f.border} hover:border-opacity-40 transition-all duration-300`}>
              <div className={`w-9 h-9 rounded-xl bg-white/[0.04] flex items-center justify-center mb-4 group-hover:scale-105 transition-transform`}>
                <f.icon className={`w-4 h-4 ${f.color}`} />
              </div>
              <h3 className="font-bold text-white text-[14px] mb-1.5">{f.title}</h3>
              <p className="text-slate-500 text-[13px] leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── CTA Banner ── */}
      <section className="pb-28 px-6 max-w-2xl mx-auto">
        <div className="relative rounded-3xl overflow-hidden border border-indigo-500/15 bg-gradient-to-br from-indigo-600/[0.12] via-violet-600/[0.08] to-purple-600/[0.05] p-10 text-center">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.12),transparent_70%)]" />
          <div className="relative">
            <ShieldCheck className="w-11 h-11 text-indigo-400 mx-auto mb-5" />
            <h2 className="text-2xl font-black tracking-[-0.03em] mb-3">Ready to browse with confidence?</h2>
            <p className="text-slate-400 text-[13px] mb-8 max-w-xs mx-auto">Free forever. No account required to scan. Works on any website.</p>
            <a href="https://chrome.google.com/webstore" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-3 px-8 py-3.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 rounded-2xl font-bold text-[15px] transition-all shadow-2xl shadow-indigo-500/20 hover:-translate-y-0.5">
              <Chrome className="w-5 h-5" />
              Add to Chrome
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.05] py-8 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
              <Shield className="w-3 h-3 text-white" />
            </div>
            <span className="text-slate-500 text-sm font-semibold">TLDR Shield</span>
          </div>
          <p className="text-slate-700 text-xs">© {new Date().getFullYear()} TLDR Shield · AI-powered privacy analysis</p>
        </div>
      </footer>
    </div>
  );
}

// ── History Page ──────────────────────────────────────────────────────────────

function HistoryPage({ user, onSignIn }: { user: User | null; onSignIn: () => void }) {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'SAFE' | 'OKAY' | 'RISKY'>('all');

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    const q = query(collection(db, 'scans'), where('userId', '==', user.uid), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, snap => {
      setScans(snap.docs.map(d => ({ id: d.id, ...d.data() } as ScanRecord)));
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [user]);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try { await deleteDoc(doc(db, 'scans', id)); } finally { setDeleting(null); }
  };

  const filtered = filter === 'all' ? scans : scans.filter(s => s.rating === filter);

  // Not signed in
  if (!user) {
    return (
      <div className="min-h-screen bg-[#080b14] text-white flex items-center justify-center px-6">
        <div className="fixed inset-0 pointer-events-none">
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-indigo-600/[0.06] rounded-full blur-[100px]" />
        </div>
        <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}
          className="relative max-w-sm w-full text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center mx-auto mb-6">
            <Clock className="w-7 h-7 text-indigo-400" />
          </div>
          <h1 className="text-2xl font-black tracking-[-0.03em] mb-3">Your scan history</h1>
          <p className="text-slate-500 text-sm leading-relaxed mb-8">
            Sign in to save scan verdicts across devices and review past results.
          </p>
          <button onClick={onSignIn}
            className="w-full flex items-center justify-center gap-3 py-3.5 bg-white hover:bg-slate-100 text-slate-900 rounded-2xl font-bold text-[15px] transition-all shadow-2xl shadow-black/20">
            <img src="https://www.google.com/favicon.ico" className="w-4 h-4" alt="" />
            Continue with Google
          </button>
        </motion.div>
      </div>
    );
  }

  const counts = { SAFE: scans.filter(s => s.rating === 'SAFE').length, OKAY: scans.filter(s => s.rating === 'OKAY').length, RISKY: scans.filter(s => s.rating === 'RISKY').length };

  return (
    <div className="min-h-screen bg-[#080b14] text-white pt-24 pb-20 px-6">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute -top-20 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-indigo-600/[0.05] rounded-full blur-[100px]" />
      </div>
      <div className="relative max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-black tracking-[-0.03em] mb-1">Scan History</h1>
          <p className="text-slate-600 text-sm">{scans.length} scan{scans.length !== 1 ? 's' : ''} saved to your account</p>
        </div>

        {/* Stats row */}
        {scans.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            {(['SAFE', 'OKAY', 'RISKY'] as const).map(r => {
              const c = rating[r];
              return (
                <div key={r} className={`p-4 rounded-2xl ${c.bg} border ${c.border} text-center`}>
                  <div className={`text-2xl font-black ${c.text}`}>{counts[r]}</div>
                  <div className={`text-xs font-bold tracking-wider ${c.text} opacity-70`}>{r}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Filter pills */}
        <div className="flex items-center gap-2 mb-6">
          {(['all', 'SAFE', 'OKAY', 'RISKY'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 ${
                filter === f
                  ? f === 'all'  ? 'bg-white/10 text-white border border-white/15'
                  : f === 'SAFE' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20'
                  : f === 'OKAY' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/20'
                  :                'bg-rose-500/15 text-rose-300 border border-rose-500/20'
                  : 'text-slate-600 hover:text-slate-300 border border-transparent hover:border-white/10'
              }`}>
              {f === 'all' ? 'All' : f}
            </button>
          ))}
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-20">
            <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Empty */}
        {!loading && filtered.length === 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-20">
            <Shield className="w-10 h-10 text-slate-800 mx-auto mb-4" />
            <p className="text-slate-600 font-semibold text-sm">
              {filter === 'all' ? 'No scans yet — install the extension and start browsing.' : `No ${filter} scans found.`}
            </p>
          </motion.div>
        )}

        {/* Scan cards */}
        <div className="flex flex-col gap-2.5">
          <AnimatePresence>
            {filtered.map((scan, i) => {
              const c = rating[scan.rating];
              return (
                <motion.div key={scan.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -16, height: 0, marginBottom: 0, paddingBottom: 0 }}
                  transition={{ delay: i * 0.03, duration: 0.3 }}
                  className={`group flex items-center gap-4 p-4 rounded-2xl ${c.bg} border ${c.border} hover:border-opacity-50 transition-all duration-200`}>

                  {/* Score ring */}
                  <div className="shrink-0">
                    <ScoreRing score={scan.score} r={scan.rating} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-[11px] font-black tracking-wider ${c.text}`}>{scan.rating}</span>
                      <span className="text-slate-700 text-[11px]">·</span>
                      <span className="text-slate-600 text-[11px]">{scan.tier === 'deep' ? '🔬 Deep' : '⚡ Quick'}</span>
                      <span className="text-slate-700 text-[11px]">·</span>
                      <span className="text-slate-600 text-[11px]">{scan.createdAt ? timeAgo(scan.createdAt) : ''}</span>
                    </div>
                    <p className="text-white text-[13px] font-semibold truncate mb-0.5">
                      {scan.url || 'Unknown page'}
                    </p>
                    {scan.tldr && (
                      <p className="text-slate-500 text-[12px] leading-relaxed line-clamp-1">{scan.tldr}</p>
                    )}
                  </div>

                  {/* Delete */}
                  <button onClick={() => handleDelete(scan.id)} disabled={deleting === scan.id}
                    className="shrink-0 opacity-0 group-hover:opacity-100 w-8 h-8 rounded-xl flex items-center justify-center text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 transition-all">
                    {deleting === scan.id
                      ? <div className="w-3.5 h-3.5 border-2 border-rose-400 border-t-transparent rounded-full animate-spin" />
                      : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <motion.div initial={{ opacity: 0, y: 14, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.96 }}
      className={`flex items-center gap-2.5 px-5 py-3 rounded-2xl text-sm font-bold shadow-2xl text-white border ${
        type === 'success' ? 'bg-emerald-950 border-emerald-500/30 text-emerald-200' : 'bg-rose-950 border-rose-500/30 text-rose-200'
      }`}>
      {type === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <AlertTriangle className="w-4 h-4 text-rose-400" />}
      {message}
    </motion.div>
  );
}

// ── App Root ──────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState<Page>('landing');
  const [user, setUser] = useState<User | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => { return onAuthStateChanged(auth, u => setUser(u)); }, []);

  const handleSignIn = async () => {
    try { await signIn(); showToast('Signed in', 'success'); }
    catch { showToast('Sign-in failed. Try again.', 'error'); }
  };
  const handleSignOut = async () => {
    await signOut(); setPage('landing'); showToast('Signed out', 'success');
  };
  const showToast = (message: string, type: 'success' | 'error') => setToast({ message, type });

  return (
    <div className="bg-[#080b14]">
      <Nav page={page} onNav={setPage} user={user} onSignIn={handleSignIn} onSignOut={handleSignOut} />

      <AnimatePresence mode="wait">
        {page === 'landing' ? (
          <motion.div key="landing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <LandingPage onSignIn={handleSignIn} user={user} onNav={setPage} />
          </motion.div>
        ) : (
          <motion.div key="history" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <HistoryPage user={user} onSignIn={handleSignIn} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] pointer-events-none">
        <AnimatePresence>
          {toast && <Toast key={toast.message} message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
        </AnimatePresence>
      </div>
    </div>
  );
}
