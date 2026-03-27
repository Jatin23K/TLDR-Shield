import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, ShieldCheck, ShieldAlert, ShieldX, Chrome, Zap, Brain, ChevronRight, LogIn, LogOut, Trash2, Clock, AlertTriangle, CheckCircle, Search } from 'lucide-react';
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function ratingColors(rating: string) {
  if (rating === 'SAFE') return { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', dot: 'bg-emerald-400' };
  if (rating === 'OKAY') return { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400', dot: 'bg-amber-400' };
  return { bg: 'bg-rose-500/10', border: 'border-rose-500/30', text: 'text-rose-400', dot: 'bg-rose-400' };
}

function RatingIcon({ rating, className = 'w-5 h-5' }: { rating: string; className?: string }) {
  if (rating === 'SAFE') return <ShieldCheck className={`${className} text-emerald-400`} />;
  if (rating === 'OKAY') return <Shield className={`${className} text-amber-400`} />;
  return <ShieldX className={`${className} text-rose-400`} />;
}

function timeAgo(ts: Timestamp): string {
  const diff = Date.now() - ts.toMillis();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

// ── Nav ───────────────────────────────────────────────────────────────────────

function Nav({ page, onNav, user, onSignIn, onSignOut }: {
  page: Page;
  onNav: (p: Page) => void;
  user: User | null;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 py-4 border-b border-white/5 bg-slate-950/80 backdrop-blur-xl">
      <button onClick={() => onNav('landing')} className="flex items-center gap-2.5 group">
        <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
          <Shield className="w-4 h-4 text-white" />
        </div>
        <span className="font-black text-white tracking-tight">TLDR Shield</span>
      </button>

      <div className="flex items-center gap-3">
        {user && (
          <button
            onClick={() => onNav('history')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
              page === 'history'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Clock className="w-4 h-4" />
            History
          </button>
        )}

        {user ? (
          <div className="flex items-center gap-2">
            {user.photoURL && (
              <img src={user.photoURL} alt={user.displayName ?? ''} className="w-7 h-7 rounded-full ring-2 ring-white/10" />
            )}
            <button
              onClick={onSignOut}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white hover:bg-white/5 transition-all"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        ) : (
          <button
            onClick={onSignIn}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-white/5 text-white border border-white/10 hover:bg-white/10 transition-all"
          >
            <LogIn className="w-4 h-4" />
            Sign in
          </button>
        )}
      </div>
    </nav>
  );
}

// ── Landing Page ──────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: Zap,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    title: 'Quick Scan',
    desc: 'Instant SAFE / OKAY / RISKY verdict in ~4 seconds. Know before you click "I Agree".',
  },
  {
    icon: Brain,
    color: 'text-indigo-400',
    bg: 'bg-indigo-400/10',
    title: 'Deep Scan',
    desc: 'Full clause-by-clause breakdown with verbatim citations across 6 privacy pillars.',
  },
  {
    icon: Search,
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    title: 'Auto-Detect',
    desc: 'Automatically detects Terms & Conditions pages as you browse — no manual triggers needed.',
  },
  {
    icon: ShieldAlert,
    color: 'text-rose-400',
    bg: 'bg-rose-400/10',
    title: 'Dark Patterns',
    desc: 'Catches forced arbitration, class-action waivers, buried opt-outs, and manipulative language.',
  },
];

const PILLARS = [
  { label: 'AI Training',       status: 'VIOLATION', risky: true },
  { label: 'Data Selling',      status: 'VIOLATION', risky: true },
  { label: 'Transparency',      status: 'CLEAR',     risky: false },
  { label: 'Data Retention',    status: 'VIOLATION', risky: true },
  { label: 'Ownership',         status: 'VIOLATION', risky: true },
  { label: 'Dark Patterns',     status: 'VIOLATION', risky: true },
];

function LandingPage({ onSignIn, user, onNav }: { onSignIn: () => void; user: User | null; onNav: (p: Page) => void }) {
  return (
    <div className="min-h-screen bg-slate-950 text-white">

      {/* Hero */}
      <section className="pt-40 pb-28 px-6 flex flex-col items-center text-center">
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm font-semibold mb-8">
            <Shield className="w-3.5 h-3.5" /> AI-powered privacy protection
          </div>

          <h1 className="text-6xl md:text-7xl font-black tracking-tighter mb-6 leading-[0.95]">
            Stop agreeing to<br />
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-purple-400 bg-clip-text text-transparent">
              things you haven't read.
            </span>
          </h1>

          <p className="text-xl text-slate-400 max-w-xl mx-auto mb-12 leading-relaxed">
            TLDR Shield scans Terms & Conditions and Privacy Policies with AI — giving you a clear verdict before you click "I Agree".
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://chrome.google.com/webstore"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-7 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-2xl font-bold text-base transition-all shadow-2xl shadow-indigo-500/25 hover:shadow-indigo-500/40 hover:-translate-y-0.5"
            >
              <Chrome className="w-5 h-5" />
              Add to Chrome — it's free
            </a>

            {user ? (
              <button
                onClick={() => onNav('history')}
                className="flex items-center gap-2 px-7 py-4 rounded-2xl font-bold text-base border border-white/10 bg-white/5 hover:bg-white/10 transition-all"
              >
                View My Scan History
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={onSignIn}
                className="flex items-center gap-2 px-7 py-4 rounded-2xl font-bold text-base border border-white/10 bg-white/5 hover:bg-white/10 transition-all"
              >
                Sign in to save history
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </motion.div>
      </section>

      {/* Mock extension panel */}
      <section className="pb-28 px-6 flex justify-center">
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.6 }}
          className="w-80 bg-slate-900 rounded-[22px] shadow-2xl border border-white/8 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/6">
            <div className="flex items-center gap-2 text-indigo-300 font-black text-sm tracking-widest uppercase">
              <Shield className="w-4 h-4" /> TLDR Shield
            </div>
            <span className="text-slate-500 text-lg">✕</span>
          </div>
          {/* Badge */}
          <div className="mx-4 mt-4 p-4 rounded-2xl bg-rose-500/10 border-2 border-rose-500/30 text-center">
            <div className="text-rose-300 font-black text-xl tracking-widest">RISKY &nbsp; 5/100</div>
            <div className="text-rose-400/60 text-xs font-semibold mt-1">🔬 Deep Scan</div>
          </div>
          {/* TL;DR */}
          <div className="mx-4 my-3 p-3 bg-white/3 rounded-xl text-slate-400 text-xs italic leading-relaxed">
            "MegaCorp claims perpetual rights to your content, shares data with 847 partners, and retains data for 10 years after deletion."
          </div>
          {/* Pillars */}
          <div className="px-4 pb-4 flex flex-col gap-1.5">
            {PILLARS.map(p => (
              <div key={p.label} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/3 text-xs">
                <span className="font-bold text-slate-300 uppercase tracking-wider">{p.label}</span>
                <span className={`font-black px-2 py-0.5 rounded-full text-[10px] ${p.risky ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                  {p.status}
                </span>
              </div>
            ))}
          </div>
          {/* Footer */}
          <div className="px-4 pb-4 pt-2 border-t border-white/6 text-center text-slate-600 text-[10px] uppercase tracking-widest">
            TL;DR Shield · Privacy Analysis
          </div>
        </motion.div>
      </section>

      {/* Features */}
      <section className="pb-28 px-6 max-w-4xl mx-auto">
        <h2 className="text-3xl font-black text-center mb-12 tracking-tight">Everything you need to browse safely</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 * i }}
              className="p-6 rounded-2xl bg-slate-900 border border-white/6 hover:border-white/12 transition-all"
            >
              <div className={`w-10 h-10 rounded-xl ${f.bg} flex items-center justify-center mb-4`}>
                <f.icon className={`w-5 h-5 ${f.color}`} />
              </div>
              <h3 className="font-bold text-white mb-2">{f.title}</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section className="pb-24 px-6 flex justify-center">
        <div className="max-w-lg w-full bg-gradient-to-br from-indigo-600/20 to-violet-600/20 border border-indigo-500/20 rounded-3xl p-10 text-center">
          <ShieldCheck className="w-12 h-12 text-indigo-400 mx-auto mb-5" />
          <h2 className="text-2xl font-black mb-3">Ready to browse with confidence?</h2>
          <p className="text-slate-400 text-sm mb-8">Free forever. No account required to scan.</p>
          <a
            href="https://chrome.google.com/webstore"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-3 px-8 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-2xl font-bold transition-all shadow-2xl shadow-indigo-500/25"
          >
            <Chrome className="w-5 h-5" />
            Add to Chrome
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 px-6 text-center text-slate-600 text-sm">
        © {new Date().getFullYear()} TLDR Shield · Built with AI-powered privacy analysis
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

    const q = query(
      collection(db, 'scans'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc'),
    );

    const unsub = onSnapshot(q, snap => {
      setScans(snap.docs.map(d => ({ id: d.id, ...d.data() } as ScanRecord)));
      setLoading(false);
    }, () => setLoading(false));

    return unsub;
  }, [user]);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await deleteDoc(doc(db, 'scans', id));
    } finally {
      setDeleting(null);
    }
  };

  const filtered = filter === 'all' ? scans : scans.filter(s => s.rating === filter);

  // ── Not signed in ──
  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-sm w-full text-center"
        >
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto mb-6">
            <Clock className="w-8 h-8 text-indigo-400" />
          </div>
          <h1 className="text-2xl font-black mb-3">Sign in to see your history</h1>
          <p className="text-slate-400 text-sm leading-relaxed mb-8">
            Your scan history is saved to your account so you can review past verdicts anytime.
          </p>
          <button
            onClick={onSignIn}
            className="w-full flex items-center justify-center gap-3 py-4 bg-white text-slate-900 rounded-2xl font-bold hover:bg-slate-100 transition-all"
          >
            <img src="https://www.google.com/favicon.ico" className="w-4 h-4" alt="" />
            Continue with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white pt-24 pb-16 px-6">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-black tracking-tight">Scan History</h1>
            <p className="text-slate-500 text-sm mt-1">{scans.length} scan{scans.length !== 1 ? 's' : ''} saved</p>
          </div>
          {/* Filter pills */}
          <div className="flex items-center gap-1.5">
            {(['all', 'SAFE', 'OKAY', 'RISKY'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  filter === f
                    ? f === 'all'    ? 'bg-white/10 text-white'
                    : f === 'SAFE'   ? 'bg-emerald-500/20 text-emerald-300'
                    : f === 'OKAY'   ? 'bg-amber-500/20 text-amber-300'
                    :                  'bg-rose-500/20 text-rose-300'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {f === 'all' ? 'All' : f}
              </button>
            ))}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Empty */}
        {!loading && filtered.length === 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-20">
            <Shield className="w-12 h-12 text-slate-700 mx-auto mb-4" />
            <p className="text-slate-500 font-semibold">
              {filter === 'all' ? 'No scans yet. Install the extension and start scanning.' : `No ${filter} scans found.`}
            </p>
          </motion.div>
        )}

        {/* Scan list */}
        <AnimatePresence>
          {filtered.map((scan, i) => {
            const c = ratingColors(scan.rating);
            return (
              <motion.div
                key={scan.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20, height: 0, marginBottom: 0 }}
                transition={{ delay: i * 0.04 }}
                className={`mb-3 p-5 rounded-2xl border ${c.bg} ${c.border} group`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <RatingIcon rating={scan.rating} className="w-5 h-5 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      {/* URL */}
                      <div className="font-semibold text-white text-sm truncate mb-1">
                        {scan.url || 'Unknown page'}
                      </div>
                      {/* TL;DR */}
                      {scan.tldr && (
                        <p className="text-slate-400 text-xs leading-relaxed line-clamp-2 mb-2">
                          {scan.tldr}
                        </p>
                      )}
                      {/* Meta row */}
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-black tracking-wider ${c.text}`}>
                          {scan.rating} · {scan.score}/100
                        </span>
                        <span className="text-slate-600 text-xs">
                          {scan.tier === 'deep' ? '🔬 Deep' : '⚡ Quick'}
                        </span>
                        <span className="text-slate-600 text-xs">
                          {scan.createdAt ? timeAgo(scan.createdAt) : ''}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Delete */}
                  <button
                    onClick={() => handleDelete(scan.id)}
                    disabled={deleting === scan.id}
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-2 rounded-xl text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 transition-all"
                    aria-label="Delete scan"
                  >
                    {deleting === scan.id
                      ? <div className="w-4 h-4 border-2 border-rose-400 border-t-transparent rounded-full animate-spin" />
                      : <Trash2 className="w-4 h-4" />
                    }
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
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
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className={`flex items-center gap-2.5 px-5 py-3 rounded-2xl text-sm font-bold shadow-2xl text-white ${
        type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'
      }`}
    >
      {type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
      {message}
    </motion.div>
  );
}

// ── App Root ──────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState<Page>('landing');
  const [user, setUser] = useState<User | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, u => setUser(u));
  }, []);

  const handleSignIn = async () => {
    try {
      await signIn();
      showToast('Signed in successfully', 'success');
    } catch {
      showToast('Sign-in failed. Please try again.', 'error');
    }
  };

  const handleSignOut = async () => {
    await signOut();
    setPage('landing');
    showToast('Signed out', 'success');
  };

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  };

  return (
    <div className="bg-slate-950">
      <Nav page={page} onNav={setPage} user={user} onSignIn={handleSignIn} onSignOut={handleSignOut} />

      <AnimatePresence mode="wait">
        {page === 'landing' ? (
          <motion.div key="landing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <LandingPage onSignIn={handleSignIn} user={user} onNav={setPage} />
          </motion.div>
        ) : (
          <motion.div key="history" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <HistoryPage user={user} onSignIn={handleSignIn} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] pointer-events-none">
        <AnimatePresence>
          {toast && (
            <Toast
              key={toast.message}
              message={toast.message}
              type={toast.type}
              onClose={() => setToast(null)}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
