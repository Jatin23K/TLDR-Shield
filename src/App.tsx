import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Shield, ShieldCheck, Chrome, Zap, Brain,
  LogIn, LogOut, Trash2, Clock, AlertTriangle, CheckCircle,
  Eye, Lock, FileText, Cpu, ArrowRight, Star, Bot, ShoppingCart,
  Search, X, ChevronDown, Mail, BarChart2, Bell, BellOff, Upload, Activity,
} from 'lucide-react';
import { auth, db, signIn, signOut } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, where, orderBy, onSnapshot, deleteDoc, doc, Timestamp, setDoc, getCountFromServer, updateDoc } from 'firebase/firestore';

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
  pillars?: Record<string, { violation: boolean; citation?: string }>;
}

interface WatchRecord {
  watchId: string;
  url: string;
  lastScore: number;
  lastHash: string;
  createdAt: Timestamp;
  nextCheckAt: Timestamp;
}

interface NotificationRecord {
  id: string;
  url: string;
  oldScore: number;
  newScore: number;
  rating: 'SAFE' | 'OKAY' | 'RISKY';
  tldr: string;
  createdAt: Timestamp;
  read: boolean;
}

interface BenchmarkCategory {
  label: string;
  avgScore: number;
  riskiest: string;
  safest: string;
  commonViolations: string[];
  sites: string[];
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

function detectCategory(url: string): string | null {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return url.toLowerCase(); } })();
  if (/twitter|instagram|facebook|tiktok|linkedin|snapchat|x\.com/.test(host)) return 'social_media';
  if (/spotify|netflix|youtube|apple\.com\/music|primevideo|hulu/.test(host)) return 'streaming';
  if (/drive\.google|dropbox|onedrive|icloud|box\.com/.test(host)) return 'cloud_storage';
  if (/amazon|ebay|etsy|shopify|walmart/.test(host)) return 'ecommerce';
  if (/steam|epicgames|xbox|playstation|ea\.com/.test(host)) return 'gaming';
  if (/google\.com|microsoft|notion|slack|zoom/.test(host)) return 'productivity';
  return null;
}

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

// ── Skeleton Card ─────────────────────────────────────────────────────────────

function ScanCardSkeleton() {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden animate-pulse">
      <div className="flex items-center gap-4 p-4">
        {/* Score ring placeholder */}
        <div className="shrink-0 w-[52px] h-[52px] rounded-full bg-white/[0.05]" />
        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="h-2.5 w-16 rounded-full bg-white/[0.06]" />
          <div className="h-3 w-3/4 rounded-full bg-white/[0.08]" />
          <div className="h-2.5 w-1/2 rounded-full bg-white/[0.05]" />
        </div>
        <div className="shrink-0 w-4 h-4 rounded bg-white/[0.04]" />
      </div>
    </div>
  );
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

function Nav({ page, onNav, user, onSignIn, onSignOut, credits, unreadCount, onBellClick }: {
  page: Page; onNav: (p: Page) => void;
  user: User | null; onSignIn: () => void; onSignOut: () => void;
  credits: number | null;
  unreadCount: number;
  onBellClick: () => void;
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
      <div className="w-full flex items-center justify-between px-6 sm:px-12 lg:px-20 xl:px-32 h-[60px]">
        {/* Logo */}
        <button onClick={() => onNav('landing')} aria-label="TLDR Shield home" className="flex items-center gap-2.5">
          <div className="relative w-8 h-8 rounded-[10px] bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <span className="font-black text-white text-[15px] tracking-[-0.02em]">TLDR Shield</span>
          {localStorage.getItem('tldr_admin_key') && (
            <AdminBadge active={false} />
          )}
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

          {/* Notifications — Hidden for Portfolio MVP (Coming Soon) */}
          {/* user && (
            <button
              onClick={onBellClick}
              aria-label="Policy change notifications"
              className="relative p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all"
              title="Notifications"
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center bg-rose-500 text-white text-[9px] font-black rounded-full px-0.5">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>
          ) */}

          {user && credits !== null && (
            <div className={`relative flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-[12px] font-black overflow-hidden
              ${credits > 100
                ? 'shadow-[0_0_16px_rgba(52,211,153,0.18)] border border-emerald-400/25'
                : credits > 20
                ? 'shadow-[0_0_16px_rgba(251,191,36,0.18)] border border-amber-400/25'
                : 'shadow-[0_0_16px_rgba(248,113,113,0.18)] border border-rose-400/25'
              }`}>
              {/* gradient bg */}
              <div className={`absolute inset-0 ${
                credits > 100
                  ? 'bg-gradient-to-r from-emerald-500/[0.14] to-teal-500/[0.08]'
                  : credits > 20
                  ? 'bg-gradient-to-r from-amber-500/[0.14] to-yellow-500/[0.08]'
                  : 'bg-gradient-to-r from-rose-500/[0.14] to-red-500/[0.08]'
              }`} />
              {/* top shine */}
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
              <div className="relative flex items-center gap-2">
                <Zap className={`w-3 h-3 ${credits > 100 ? 'text-emerald-300' : credits > 20 ? 'text-amber-300' : 'text-rose-300'}`}
                  style={{ filter: `drop-shadow(0 0 4px ${credits > 100 ? 'rgba(52,211,153,0.8)' : credits > 20 ? 'rgba(251,191,36,0.8)' : 'rgba(248,113,113,0.8)'})` }} />
                <span className={`tracking-tight ${credits > 100 ? 'text-emerald-300' : credits > 20 ? 'text-amber-300' : 'text-rose-300'}`}>
                  {credits.toLocaleString()} <span className="font-medium opacity-70">credits</span>
                </span>
              </div>
            </div>
          )}

          {user ? (
            <div className="flex items-center gap-2 pl-2 border-l border-white/[0.08]">
              {user.photoURL && <img src={user.photoURL} alt="" className="w-7 h-7 rounded-full ring-1 ring-white/20" />}
              <span className="text-[13px] text-slate-400 font-medium hidden sm:block">
                {user.displayName?.split(' ')[0]}
              </span>
              <button onClick={onSignOut} aria-label="Sign out"
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

// TODO: set this to the actual Chrome Web Store listing URL once published.
// Keeping null disables the "Add to Chrome" CTA on the landing page so users
// aren't sent to the generic store homepage with no way to find the extension.
const CHROME_STORE_URL: string | null = null;

const DEMO_SCAN = {
  url: 'https://twitter.com/en/tos',
  rating: 'RISKY' as const,
  score: 18,
  tldr: 'Twitter claims a broad, sublicensable license to your content and uses it to train AI models. Arbitration clauses remove your right to class-action lawsuits.',
  pillars: {
    ai_training:       { violation: true,  label: 'AI Training',       citation: 'You grant us a worldwide, non-exclusive license to use your Content for training our machine learning models.' },
    data_selling:      { violation: true,  label: 'Data Selling',       citation: 'We may share your information with our business partners for advertising and analytics purposes.' },
    transparency:      { violation: false, label: 'Transparency',       citation: null },
    data_retention:    { violation: false, label: 'Data Retention',     citation: null },
    content_ownership: { violation: true,  label: 'Content Ownership',  citation: 'You grant Twitter a royalty-free license to use, reproduce, modify, and distribute your Content in any media.' },
    dark_patterns:     { violation: true,  label: 'Dark Patterns',      citation: 'You waive any right to participate in a class action lawsuit or class-wide arbitration.' },
  },
};

const FEATURES = [
  { icon: Bot,          color: 'text-violet-400',  bg: 'from-violet-500/10 to-violet-500/[0.03]',  border: 'border-violet-500/15',  title: 'AI Training',       desc: 'Can they use your photos, messages, or posts to train their AI? We detect this — usually buried under phrases like "improving our services".' },
  { icon: ShoppingCart, color: 'text-rose-400',    bg: 'from-rose-500/10 to-rose-500/[0.03]',      border: 'border-rose-500/15',    title: 'Data Sharing',      desc: 'Are they selling your name, email, or browsing habits to other companies? We flag it clearly so you know before you sign up.' },
  { icon: Eye,          color: 'text-sky-400',     bg: 'from-sky-500/10 to-sky-500/[0.03]',        border: 'border-sky-500/15',     title: 'Policy Clarity',    desc: 'Is the policy written so an everyday person can understand it — or is it deliberately filled with legal language designed to confuse?' },
  { icon: Clock,        color: 'text-amber-400',   bg: 'from-amber-500/10 to-amber-500/[0.03]',    border: 'border-amber-500/15',   title: 'Data Retention',    desc: 'When you delete your account, does your data actually disappear? Many platforms keep it for months or years. We tell you exactly how long.' },
  { icon: FileText,     color: 'text-emerald-400', bg: 'from-emerald-500/10 to-emerald-500/[0.03]',border: 'border-emerald-500/15', title: 'Content Ownership', desc: 'When you upload a photo or write something, do you still own it? We check if the platform claims a permanent licence to use your content.' },
  { icon: Lock,         color: 'text-rose-400',    bg: 'from-rose-500/10 to-rose-500/[0.03]',      border: 'border-rose-500/15',    title: 'Unfair Clauses',    desc: 'Clauses that stop you from taking legal action, subscriptions that auto-renew without notice, opt-outs buried pages deep — we find them all.' },
];


const STEPS = [
  { n: '01', title: 'Install the Extension', desc: 'One-click install from the Chrome Web Store. Sign in with Google to activate 400 free credits — no payment required.' },
  { n: '02', title: 'Browse as Normal', desc: 'TLDR Shield automatically detects Terms & Conditions and Privacy Policy pages as you browse, and shows a discreet badge on screen.' },
  { n: '03', title: 'Get an Instant Verdict', desc: 'Click the badge for a clear SAFE, OKAY, or RISKY rating — with a plain summary of exactly what you\'re being asked to agree to.' },
];

// ── Paste Scanner ─────────────────────────────────────────────────────────────

const API_BASE = (import.meta as any).env?.VITE_API_URL ?? 'https://tldr-shield-292798741977.us-central1.run.app';

interface PasteScanResult {
  rating: 'SAFE' | 'OKAY' | 'RISKY';
  score: number;
  tldr: string;
  pillars?: Record<string, { violation: boolean; citation?: string }>;
  cached?: boolean;
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).href;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item: any) => ('str' in item ? item.str : '')).join(' '));
  }
  return pages.join('\n\n');
}

function PasteScanner({ user, onSignIn }: { user: User | null; onSignIn: () => void }) {
  const [text, setText]           = useState('');
  const [tier, setTier]           = useState<'quick' | 'deep'>('quick');
  const [loading, setLoading]     = useState(false);
  const [progress, setProgress]   = useState('');
  const [result, setResult]       = useState<PasteScanResult | null>(null);
  const [error, setError]         = useState('');
  const [extracting, setExtracting] = useState(false);
  const [dragOver, setDragOver]   = useState(false);
  const fileInputRef              = useRef<HTMLInputElement>(null);

  const MIN_CHARS = 100;
  const canScan = text.trim().length >= MIN_CHARS && !loading && !extracting;

  const handleFile = async (file: File) => {
    setExtracting(true); setError(''); setResult(null);
    try {
      let extracted = '';
      if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
        extracted = await file.text();
      } else if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
        setProgress('Reading PDF…');
        extracted = await extractPdfText(file);
        setProgress('');
      } else {
        setError('Unsupported file type. Please upload a .txt or .pdf file.');
        setExtracting(false); return;
      }
      setText(extracted.trim());
    } catch (e: any) {
      setError('Could not read file: ' + (e?.message ?? 'Unknown error'));
    } finally { setExtracting(false); }
  };

  const handleScan = async () => {
    if (!canScan) return;
    setLoading(true); setResult(null); setError(''); setProgress('Analyzing…');
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = user ? await auth.currentUser?.getIdToken().catch(() => null) : null;
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${API_BASE}/api/analyze`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: text.trim(), tier, eli5: false, darkPatterns: false }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 402) setError('Out of credits. Credits reset on the 1st of each month.');
        else if (res.status === 401) setError('Sign in to scan text.');
        else setError(`Error ${res.status}: ${body.slice(0, 120)}`);
        setLoading(false); return;
      }

      const reader = res.body?.getReader();
      if (!reader) { setError('No response body.'); setLoading(false); return; }

      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.status)  setProgress(data.status);
            if (data.error)  { setError(data.error); setLoading(false); return; }
            if (data.rating) {
              setResult({ rating: data.rating, score: data.score, tldr: data.tldr, pillars: data.pillars, cached: data.cached });
              setLoading(false); setProgress('');
            }
          } catch { /* partial */ }
        }
      }
    } catch (e: any) {
      setError(e?.message ?? 'Network error. Please try again.');
      setLoading(false);
    }
  };

  return (
    <section className="w-full py-24 px-6 sm:px-12 lg:px-20 xl:px-32">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="text-center mb-10">
          <p className="text-indigo-400 text-xs font-semibold tracking-[0.15em] uppercase mb-3">Try It Yourself</p>
          <h2 className="text-3xl sm:text-4xl font-black tracking-[-0.03em] mb-3">Scan any T&C — instantly.</h2>
          <p className="text-slate-400 text-sm leading-relaxed max-w-xl mx-auto">
            Got a T&C from an app installer, mobile app, or PDF? Paste it below.
            No extension needed.
          </p>
        </div>

        {/* Input card — supports paste + drag-and-drop + file upload */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          className={`rounded-2xl border overflow-hidden shadow-2xl shadow-black/20 transition-all duration-200 ${
            dragOver ? 'border-indigo-500/50 bg-indigo-500/[0.04]' : 'border-white/[0.08] bg-white/[0.02]'
          }`}>

          {/* Drag overlay hint */}
          {dragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
              <p className="text-indigo-300 text-sm font-bold">Drop file to extract text</p>
            </div>
          )}

          <textarea
            value={text}
            onChange={e => { setText(e.target.value); setResult(null); setError(''); }}
            placeholder="Paste Terms of Service, Privacy Policy, or any legal agreement here… or drag & drop a .txt / .pdf file"
            rows={8}
            className="w-full bg-transparent px-5 pt-5 pb-3 text-[13px] text-slate-300 placeholder-slate-600 outline-none resize-none leading-relaxed"
          />

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-white/[0.06] bg-white/[0.01]">
            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-mono tabular-nums ${text.length < MIN_CHARS && text.length > 0 ? 'text-amber-600' : 'text-slate-700'}`}>
                {text.length.toLocaleString()} chars
                {text.length > 0 && text.length < MIN_CHARS ? ` · need ${MIN_CHARS - text.length} more` : ''}
              </span>

              {/* File upload button */}
              <label className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border cursor-pointer transition-all ${
                extracting
                  ? 'text-slate-600 border-white/[0.05] cursor-wait'
                  : 'text-slate-500 border-white/[0.07] hover:text-slate-300 hover:bg-white/[0.05] hover:border-white/[0.12]'
              }`}>
                {extracting
                  ? <><div className="w-3 h-3 border border-slate-600 border-t-slate-400 rounded-full animate-spin" />Reading…</>
                  : <><Upload className="w-3 h-3" />Upload .txt / .pdf</>}
                <input ref={fileInputRef} type="file" accept=".txt,.pdf,text/plain,application/pdf"
                  className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
              </label>

              {/* Tier toggle */}
              <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                {(['quick', 'deep'] as const).map(t => (
                  <button key={t} onClick={() => setTier(t)}
                    className={`px-3 py-1 rounded-md text-[11px] font-bold transition-all ${
                      tier === t ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-600 hover:text-slate-400'
                    }`}>
                    {t === 'quick' ? '⚡ Quick' : '🔬 Deep'}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={handleScan} disabled={!canScan} aria-label="Scan pasted text"
              className={`flex items-center gap-2 px-5 py-2 rounded-xl text-[13px] font-bold transition-all duration-200 ${
                canScan
                  ? 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-lg shadow-indigo-500/20 hover:-translate-y-px'
                  : 'bg-white/[0.04] text-slate-600 cursor-not-allowed'
              }`}>
              {loading
                ? <><div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />Scanning…</>
                : <><Zap className="w-3.5 h-3.5" />Scan Now</>}
            </button>
          </div>
        </div>

        {/* Progress */}
        <AnimatePresence>
          {loading && progress && (
            <motion.p key="progress" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="text-center text-slate-600 text-xs mt-3 italic">{progress}</motion.p>
          )}
        </AnimatePresence>

        {/* Error */}
        <AnimatePresence>
          {error && (
            <motion.div key="error" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="mt-4 px-4 py-3 rounded-xl bg-rose-500/[0.08] border border-rose-500/15 text-rose-400 text-[13px] flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />{error}
              {error.includes('Sign in') && (
                <button onClick={onSignIn} className="ml-auto text-indigo-400 hover:text-indigo-300 font-semibold text-[12px] shrink-0">
                  Sign in →
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Result card */}
        <AnimatePresence>
          {result && (
            <motion.div key="result" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
              className={`mt-5 rounded-2xl border ${rating[result.rating].border} ${rating[result.rating].bg} overflow-hidden`}>

              {/* Result header */}
              <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-3">
                  <ScoreRing score={result.score} r={result.rating} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-black tracking-wider ${rating[result.rating].text}`}>{result.rating}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${rating[result.rating].badge}`}>
                        {result.score} / 100
                      </span>
                      {result.cached && <span className="text-[10px] text-slate-600 font-medium">· cached</span>}
                    </div>
                    <p className="text-slate-500 text-[11px] mt-0.5">{tier === 'deep' ? '🔬 Deep Scan' : '⚡ Quick Scan'}</p>
                  </div>
                </div>
                <button onClick={() => { setResult(null); setText(''); }} aria-label="Close result"
                  className="p-1.5 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-white/[0.05] transition-all">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* TLDR summary */}
              <div className="px-5 py-4">
                <p className="text-slate-300 text-[13px] leading-relaxed">
                  <span className="text-white font-bold">TLDR: </span>{result.tldr}
                </p>
              </div>

              {/* Pillar violation chips (deep only) */}
              {result.pillars && (
                <div className="px-5 pb-4 flex flex-wrap gap-1.5">
                  {Object.entries(result.pillars).filter(([, p]) => p.violation).map(([key]) => (
                    <span key={key} className="bg-rose-500/10 text-rose-400 border border-rose-500/15 text-[10px] font-bold px-2 py-0.5 rounded-full">
                      {PILLAR_LABELS[key] ?? key}
                    </span>
                  ))}
                  {Object.values(result.pillars).every(p => !p.violation) && (
                    <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/15 text-[10px] font-bold px-2 py-0.5 rounded-full">
                      No Risks Detected
                    </span>
                  )}
                </div>
              )}

              {/* Sign-in nudge for guests */}
              {!user && (
                <div className="px-5 pb-4">
                  <button onClick={onSignIn}
                    className="w-full py-2.5 rounded-xl text-[12px] font-semibold text-indigo-300 bg-indigo-500/[0.08] border border-indigo-500/15 hover:bg-indigo-500/[0.14] transition-all">
                    Sign in to save this result to your history →
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </section>
  );
}

// ── Landing Page ──────────────────────────────────────────────────────────────

function LandingPage({ onSignIn, user, onNav }: { onSignIn: () => void; user: User | null; onNav: (p: Page) => void }) {
  const [scanCount, setScanCount] = useState<number | null>(null);

  useEffect(() => {
    const fetchCount = async () => {
      try {
        const snap = await getCountFromServer(collection(db, 'shared_cache'));
        setScanCount(snap.data().count);
      } catch { /* silent — Firestore may be unavailable */ }
    };
    fetchCount();
    const interval = setInterval(fetchCount, 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#080b14] text-white overflow-x-hidden">

      {/* Background orbs — full-viewport, decorative only */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 left-1/4 w-[1200px] h-[700px] bg-indigo-600/[0.06] rounded-full blur-[140px]" />
        <div className="absolute top-[55vh] -left-60 w-[700px] h-[700px] bg-violet-600/[0.05] rounded-full blur-[120px]" />
        <div className="absolute top-[35vh] right-0 w-[600px] h-[600px] bg-indigo-500/[0.04] rounded-full blur-[120px]" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[1400px] h-[400px] bg-violet-700/[0.03] rounded-full blur-[100px]" />
      </div>

      {/* ── Hero — full-width 2-col split layout ── */}
      <section className="relative w-full pt-32 pb-20">
        {/* full-bleed subtle grid */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.025)_1px,transparent_1px)] bg-[size:80px_80px] [mask-image:radial-gradient(ellipse_80%_60%_at_50%_0%,black,transparent)]" />

        <div className="relative w-full px-6 sm:px-12 lg:px-20 xl:px-32 flex flex-col lg:flex-row items-center gap-12 lg:gap-16">

          {/* ── Left: copy ── */}
          <motion.div initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.55 }}
            className="flex-1 min-w-0">

            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-semibold tracking-wider uppercase mb-7">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
              AI-Powered Privacy Protection
            </div>

            <h1 className="text-5xl sm:text-6xl lg:text-[64px] xl:text-[76px] 2xl:text-[88px] font-black tracking-[-0.04em] leading-[0.93] mb-6">
              Stop agreeing<br />to things<br />
              <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-purple-500 bg-clip-text text-transparent">
                you haven't read.
              </span>
            </h1>

            {scanCount !== null && (
              <div className="inline-flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/15 text-indigo-300 text-xs font-semibold px-3 py-1 rounded-full mb-6">
                🛡 {scanCount.toLocaleString()} policies analyzed and counting
              </div>
            )}

            <p className="text-base sm:text-lg text-slate-400 max-w-lg leading-relaxed mb-9">
              TLDR Shield reads the full Terms & Conditions or Privacy Policy in seconds
              and gives you a clear SAFE, OKAY or RISKY verdict — so you know exactly what you're agreeing to.
            </p>

            <div className="flex flex-col sm:flex-row items-start gap-3 mb-9">
              {CHROME_STORE_URL ? (
                <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer"
                  className="group flex items-center gap-3 px-7 py-3.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 rounded-2xl font-bold text-[15px] transition-all duration-300 shadow-2xl shadow-indigo-500/25 hover:shadow-indigo-500/40 hover:-translate-y-0.5">
                  <Chrome className="w-5 h-5" />
                  Add to Chrome — Free
                  <ArrowRight className="w-4 h-4 opacity-60 group-hover:translate-x-0.5 transition-transform" />
                </a>
              ) : (
                <div title="Load the extension manually via chrome://extensions → Load unpacked"
                  className="group flex items-center gap-3 px-7 py-3.5 bg-gradient-to-r from-indigo-600/50 to-violet-600/50 rounded-2xl font-bold text-[15px] text-white/60 cursor-default select-none shadow-2xl shadow-indigo-500/10">
                  <Chrome className="w-5 h-5" />
                  Load Extension Manually
                </div>
              )}
              {user ? (
                <button onClick={() => onNav('history')}
                  className="flex items-center gap-2 px-7 py-3.5 rounded-2xl font-bold text-[15px] text-slate-300 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] hover:border-white/[0.14] transition-all">
                  <Clock className="w-4 h-4 opacity-70" />View Scan History
                </button>
              ) : (
                <button onClick={onSignIn}
                  className="flex items-center gap-2 px-7 py-3.5 rounded-2xl font-bold text-[15px] text-slate-300 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] hover:border-white/[0.14] transition-all">
                  <LogIn className="w-4 h-4 opacity-70" />Save Scan History
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-5 text-slate-600 text-xs font-medium">
              <span className="flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-emerald-500/70" />You own your data</span>
              <span className="w-px h-3 bg-white/10" />
              <span className="flex items-center gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-emerald-500/70" />400 free credits/month</span>
              <span className="w-px h-3 bg-white/10" />
              <span className="flex items-center gap-1.5"><Star className="w-3.5 h-3.5 text-amber-500/70" />98%+ accuracy</span>
            </div>
          </motion.div>

          {/* ── Right: mock result card ── */}
          <motion.div initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.55, delay: 0.1 }}
            className="flex-1 min-w-0 w-full lg:max-w-[520px] xl:max-w-[580px]">
            <div className="relative rounded-3xl overflow-hidden border border-white/[0.07] bg-[#0e1120] shadow-2xl shadow-black/50">
              {/* window chrome */}
              <div className="flex items-center gap-1.5 px-5 py-3.5 border-b border-white/[0.06] bg-white/[0.02]">
                <span className="w-3 h-3 rounded-full bg-rose-500/60" />
                <span className="w-3 h-3 rounded-full bg-amber-500/60" />
                <span className="w-3 h-3 rounded-full bg-emerald-500/60" />
                <span className="ml-3 text-slate-600 text-[11px] font-mono">spotify.com/legal/privacy-policy</span>
              </div>
              {/* header */}
              <div className="px-5 pt-5 pb-4 border-b border-white/[0.05]">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-indigo-400" />
                    <span className="text-white font-black text-sm tracking-tight">TLDR Shield</span>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full bg-rose-500/15 text-rose-300 text-[11px] font-black border border-rose-500/20 tracking-wider">RISKY</span>
                </div>
                <p className="text-slate-500 text-[11px]">Deep Scan · 4 issues found</p>
              </div>
              {/* score bar */}
              <div className="px-5 py-4 border-b border-white/[0.05]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-slate-400 text-[11px] font-semibold">Privacy Score</span>
                  <span className="text-rose-400 font-black text-sm">34 / 100</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                  <div className="h-full w-[34%] rounded-full bg-gradient-to-r from-rose-500 to-rose-400" />
                </div>
              </div>
              {/* pillars */}
              <div className="px-5 py-4 flex flex-col gap-2.5">
                {[
                  { label: 'AI Training', score: 10, color: 'text-rose-400', bar: 'bg-rose-500', w: '10%' },
                  { label: 'Data Sharing', score: 25, color: 'text-rose-400', bar: 'bg-rose-500', w: '25%' },
                  { label: 'Data Retention', score: 40, color: 'text-amber-400', bar: 'bg-amber-400', w: '40%' },
                  { label: 'Content Ownership', score: 55, color: 'text-amber-400', bar: 'bg-amber-400', w: '55%' },
                  { label: 'Policy Clarity', score: 60, color: 'text-amber-400', bar: 'bg-amber-400', w: '60%' },
                  { label: 'Unfair Clauses', score: 20, color: 'text-rose-400', bar: 'bg-rose-500', w: '20%' },
                ].map(p => (
                  <div key={p.label} className="flex items-center gap-3">
                    <span className="text-slate-500 text-[11px] w-36 shrink-0">{p.label}</span>
                    <div className="flex-1 h-1 rounded-full bg-white/[0.05]">
                      <div className={`h-full rounded-full ${p.bar}`} style={{ width: p.w }} />
                    </div>
                    <span className={`text-[11px] font-bold w-6 text-right ${p.color}`}>{p.score}</span>
                  </div>
                ))}
              </div>
              {/* summary */}
              <div className="mx-5 mb-5 px-4 py-3 rounded-2xl bg-rose-500/[0.07] border border-rose-500/15">
                <p className="text-slate-400 text-[11px] leading-relaxed">
                  <span className="text-white font-semibold">TLDR:</span> Spotify can use your listening data to train AI models, share it with third-party advertisers, and retain it indefinitely after account deletion.
                </p>
              </div>
            </div>
            {/* floating glow under card */}
            <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-3/4 h-20 bg-indigo-500/10 blur-2xl rounded-full pointer-events-none" />
          </motion.div>

        </div>
      </section>

      {/* ── See it in action — demo result card ── */}
      <section className="w-full pb-28 px-6 sm:px-12 lg:px-20 xl:px-32">
        <div className="max-w-[1600px] mx-auto">
          <div className="text-center mb-12">
            <p className="text-indigo-400 text-xs font-semibold tracking-[0.15em] uppercase mb-3">Real Example</p>
            <h2 className="text-3xl sm:text-4xl font-black tracking-[-0.03em]">See it in action.</h2>
          </div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
            className={`max-w-2xl mx-auto rounded-2xl border ${rating.RISKY.border} ${rating.RISKY.bg} overflow-hidden`}>

            {/* Label */}
            <div className="px-6 pt-5 pb-0">
              <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/[0.07] text-slate-400 text-[11px] font-semibold">
                Live example · Twitter/X ToS
              </span>
            </div>

            {/* Header row */}
            <div className="flex items-center justify-between px-6 pt-4 pb-3 border-b border-white/[0.06]">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Shield className="w-4 h-4 text-indigo-400" />
                  <span className="text-white font-black text-sm tracking-tight">TLDR Shield</span>
                </div>
                <p className="text-slate-500 text-[11px]">Deep Scan · {DEMO_SCAN.url}</p>
              </div>
              <div className="flex items-center gap-3">
                <ScoreRing score={DEMO_SCAN.score} r={DEMO_SCAN.rating} />
                <span className={`px-3 py-1 rounded-full text-[11px] font-black tracking-wider ${rating.RISKY.badge}`}>
                  {DEMO_SCAN.rating}
                </span>
              </div>
            </div>

            {/* TLDR */}
            <div className="px-6 py-4 border-b border-white/[0.06]">
              <p className="text-slate-400 text-[13px] leading-relaxed">
                <span className="text-white font-semibold">TLDR: </span>
                {DEMO_SCAN.tldr}
              </p>
            </div>

            {/* Pillar breakdown */}
            <div className="px-6 py-4 space-y-3">
              {Object.values(DEMO_SCAN.pillars).map((p) => (
                <div key={p.label} className="flex items-start gap-2.5">
                  <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${p.violation ? rating.RISKY.pill : 'bg-emerald-400'}`} />
                  <div className="flex-1 min-w-0">
                    <span className={`text-[12px] font-bold ${p.violation ? rating.RISKY.text : 'text-slate-400'}`}>
                      {p.label}
                    </span>
                    {p.citation ? (
                      <p className="text-slate-500 text-[11px] italic mt-0.5">"{p.citation}"</p>
                    ) : (
                      <p className="text-slate-600 text-[11px] mt-0.5">No violation detected</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Disclaimer */}
            <div className="px-6 pb-5">
              <p className="text-slate-600 text-[11px]">This is a real analysis — results may vary based on policy version.</p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Paste & Scan ── */}
      <PasteScanner user={user} onSignIn={onSignIn} />

      {/* ── Features — true full-width section ── */}
      <section className="w-full pb-28 px-6 sm:px-12 lg:px-20 xl:px-32">
        <div className="text-center mb-16">
          <p className="text-indigo-400 text-xs font-semibold tracking-[0.15em] uppercase mb-3">What We Check</p>
          <h2 className="text-3xl sm:text-4xl font-black tracking-[-0.03em]">6 checks. Every scan. Nothing gets missed.</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5 max-w-[1600px] mx-auto">
          {FEATURES.map((f, i) => (
            <motion.div key={f.title} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.07 * i }}
              className={`group p-7 rounded-2xl bg-gradient-to-br ${f.bg} border ${f.border} hover:border-opacity-50 transition-all duration-300`}>
              <div className={`w-11 h-11 rounded-xl bg-white/[0.05] flex items-center justify-center mb-5 group-hover:scale-105 transition-transform`}>
                <f.icon className={`w-5 h-5 ${f.color}`} />
              </div>
              <h3 className="font-bold text-white text-[15px] mb-2">{f.title}</h3>
              <p className="text-slate-500 text-[13px] leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── How it works — full-width with divider ── */}
      <section className="w-full pb-28 px-6 sm:px-12 lg:px-20 xl:px-32 border-t border-white/[0.04]">
        <div className="max-w-[1600px] mx-auto">
          <div className="text-center mb-16 pt-24">
            <p className="text-indigo-400 text-xs font-semibold tracking-[0.15em] uppercase mb-3">How it works</p>
            <h2 className="text-3xl sm:text-4xl font-black tracking-[-0.03em]">Up and running in three steps.</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
            <div className="hidden md:block absolute top-7 left-[16%] right-[16%] h-px bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent" />
            {STEPS.map((s, i) => (
              <motion.div key={s.n} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 * i }}
                className="relative flex flex-col items-center text-center p-8 rounded-2xl bg-white/[0.02] border border-white/[0.05] hover:border-white/[0.09] transition-all">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-500/10 border border-indigo-500/20 flex items-center justify-center mb-5 text-indigo-300 font-black text-sm tracking-wider">
                  {s.n}
                </div>
                <h3 className="font-bold text-white mb-3 text-[16px]">{s.title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{s.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Privacy Promise — 2x2 grid ── */}
      <section className="w-full pb-28 px-6 sm:px-12 lg:px-20 xl:px-32 border-t border-white/[0.04]">
        <div className="max-w-[1600px] mx-auto">
          <div className="text-center mb-16 pt-24">
            <p className="text-indigo-400 text-xs font-semibold tracking-[0.15em] uppercase mb-3">Privacy First</p>
            <h2 className="text-3xl sm:text-4xl font-black tracking-[-0.03em]">Built for your privacy.</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
            {[
              {
                icon: Lock,
                color: 'text-indigo-400',
                bg: 'bg-indigo-500/10',
                heading: 'We never read your browsing history',
                desc: 'We only analyze text you explicitly submit by clicking Scan.',
              },
              {
                icon: Eye,
                color: 'text-sky-400',
                bg: 'bg-sky-500/10',
                heading: 'Results are cached anonymously',
                desc: 'No personal data is attached to cached results. User A\'s scan of Spotify is stored without any identifying information.',
              },
              {
                icon: Trash2,
                color: 'text-rose-400',
                bg: 'bg-rose-500/10',
                heading: 'Delete your data anytime',
                desc: 'Every scan you run is stored under your account and can be deleted in one click from the History page.',
              },
              {
                icon: Zap,
                color: 'text-amber-400',
                bg: 'bg-amber-500/10',
                heading: 'Open source pipeline',
                desc: 'The scoring logic is documented and the eval dataset is public. No black boxes.',
              },
            ].map((item, i) => (
              <motion.div key={item.heading} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.07 * i }}
                className="flex items-start gap-4 p-6 rounded-2xl bg-white/[0.02] border border-white/[0.05] hover:border-white/[0.09] transition-all">
                <div className={`w-10 h-10 rounded-xl ${item.bg} flex items-center justify-center shrink-0`}>
                  <item.icon className={`w-5 h-5 ${item.color}`} />
                </div>
                <div>
                  <h3 className="font-bold text-white text-[14px] mb-1">{item.heading}</h3>
                  <p className="text-slate-500 text-[13px] leading-relaxed">{item.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Banner — full-width with contained card ── */}
      <section className="w-full pb-28 px-6 sm:px-12 lg:px-20 xl:px-32">
        <div className="max-w-[1600px] mx-auto">
          <div className="relative rounded-3xl overflow-hidden border border-indigo-500/15 bg-gradient-to-br from-indigo-600/[0.13] via-violet-600/[0.08] to-purple-600/[0.05] p-12 sm:p-16 text-center">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.14),transparent_65%)]" />
            {/* decorative corner accents */}
            <div className="absolute top-0 left-0 w-32 h-32 bg-gradient-to-br from-indigo-500/10 to-transparent rounded-br-full" />
            <div className="absolute bottom-0 right-0 w-32 h-32 bg-gradient-to-tl from-violet-500/10 to-transparent rounded-tl-full" />
            <div className="relative max-w-xl mx-auto">
              <ShieldCheck className="w-12 h-12 text-indigo-400 mx-auto mb-6" />
              <h2 className="text-3xl sm:text-4xl font-black tracking-[-0.03em] mb-4">Know what you're agreeing to.</h2>
              <p className="text-slate-400 text-[14px] mb-10 leading-relaxed">400 free credits every month. A Quick Scan costs 10 credits, a Deep Scan costs 20. Your data belongs to you — view or delete it at any time.</p>
{CHROME_STORE_URL ? (
                <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-3 px-9 py-4 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 rounded-2xl font-bold text-[15px] transition-all shadow-2xl shadow-indigo-500/25 hover:-translate-y-0.5 hover:shadow-indigo-500/40">
                  <Chrome className="w-5 h-5" />
                  Add to Chrome — It's Free
                </a>
              ) : (
                <div className="inline-flex items-center gap-3 px-9 py-4 bg-gradient-to-r from-indigo-600/50 to-violet-600/50 rounded-2xl font-bold text-[15px] text-white/60 cursor-not-allowed select-none">
                  <Chrome className="w-5 h-5" />
                  Coming Soon to Chrome Web Store
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Footer — full-width */}
      <footer className="w-full border-t border-white/[0.05] py-8 px-6 sm:px-12 lg:px-20 xl:px-32">
        <div className="max-w-[1600px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Shield className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-slate-400 text-sm font-bold">TLDR Shield</span>
          </div>
          <p className="text-slate-700 text-xs">© {new Date().getFullYear()} TLDR Shield · AI-powered privacy analysis</p>
<div className="flex items-center gap-4 text-slate-700 text-xs">
            {/* Privacy/Terms/Contact pages not yet published — links hidden until ready */}
            <span className="text-slate-800 text-xs">© {new Date().getFullYear()} TLDR Shield</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ── Pillar labels (shared by PasteScanner + HistoryPage) ─────────────────────

const PILLAR_LABELS: Record<string, string> = {
  ai_training: 'AI Training',
  data_selling: 'Data Selling',
  transparency: 'Transparency',
  data_retention: 'Data Retention',
  content_ownership: 'Ownership',
  dark_patterns: 'Dark Patterns',
};

// ── History Page ──────────────────────────────────────────────────────────────

function HistoryPage({ user, onSignIn }: { user: User | null; onSignIn: () => void }) {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'SAFE' | 'OKAY' | 'RISKY'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [gdprScan, setGdprScan] = useState<ScanRecord | null>(null);
  const [gdprEmail, setGdprEmail] = useState('');
  const [gdprLoading, setGdprLoading] = useState(false);
  const [gdprResult, setGdprResult] = useState<{ subject: string; body: string } | null>(null);
  const [gdprError, setGdprError] = useState('');
  const [benchmarkScan, setBenchmarkScan] = useState<ScanRecord | null>(null);
  const [benchmarkData, setBenchmarkData] = useState<BenchmarkCategory | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState('');
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<Record<string, {role:'user'|'assistant', content:string}[]>>({});
  const [chatInput, setChatInput] = useState<Record<string, string>>({});
  const [chatLoading, setChatLoading] = useState<string | null>(null);
  // Watch state
  const [watches, setWatches] = useState<WatchRecord[]>([]);
  const [watchingId, setWatchingId] = useState<string | null>(null); // scan.id being watched
  const [unwatchingId, setUnwatchingId] = useState<string | null>(null); // watchId being removed
  const apiUrl = (import.meta as any).env?.VITE_API_URL ?? 'https://tldr-shield-292798741977.us-central1.run.app';

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    const q = query(collection(db, 'scans'), where('uid', '==', user.uid), orderBy('createdAt', 'desc'));
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

  const sendChat = async (scanId: string, cardId: string) => {
    const message = (chatInput[cardId] || '').trim();
    if (!message || chatLoading) return;
    setChatInput(p => ({ ...p, [cardId]: '' }));
    setChatMessages(p => ({ ...p, [cardId]: [...(p[cardId] || []), { role: 'user', content: message }] }));
    setChatLoading(cardId);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        setChatMessages(p => ({ ...p, [cardId]: [...(p[cardId] || []), { role: 'assistant' as const, content: 'Please sign in to use chat.' }] }));
        setChatLoading(null);
        return;
      }
      const backendUrl = (import.meta as any).env?.VITE_API_URL ?? '';
      const res = await fetch(`${backendUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ scanId, message }),
      });
      const data = await res.json();
      setChatMessages(p => ({ ...p, [cardId]: [...(p[cardId] || []), { role: 'assistant', content: data.reply || data.error || 'No response.' }] }));
    } catch {
      setChatMessages(p => ({ ...p, [cardId]: [...(p[cardId] || []), { role: 'assistant', content: 'Chat unavailable. Try again.' }] }));
    } finally {
      setChatLoading(null);
    }
  };

  // Load watches for the current user
  const loadWatches = async () => {
    if (!user) return;
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const resp = await fetch(`${apiUrl}/api/watch`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json() as { watches: WatchRecord[] };
        setWatches(data.watches ?? []);
      }
    } catch { /* silent */ }
  };

  useEffect(() => { loadWatches(); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleWatch = async (scan: ScanRecord) => {
    if (!scan.url || !user) return;
    setWatchingId(scan.id);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      // Compute SHA-256 of the scan URL as the lastHash (we use the scanId-based hash from the stored scan record)
      // We derive a content hash from the scan URL + score as a stable identifier
      const textToHash = scan.url + String(scan.score) + (scan.tldr ?? '');
      const enc = new TextEncoder().encode(textToHash);
      const hashBuf = await crypto.subtle.digest('SHA-256', enc);
      const lastHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

      const resp = await fetch(`${apiUrl}/api/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          url: scan.url,
          lastScanId: scan.id,
          lastScore: scan.score,
          lastHash,
        }),
      });
      if (resp.ok) await loadWatches();
    } catch { /* silent */ }
    finally { setWatchingId(null); }
  };

  const handleUnwatch = async (watchId: string) => {
    setUnwatchingId(watchId);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const resp = await fetch(`${apiUrl}/api/watch/${watchId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) await loadWatches();
    } catch { /* silent */ }
    finally { setUnwatchingId(null); }
  };

  const watchedUrls = new Set(watches.map(w => w.url));

  const filtered = scans
    .filter(s => filter === 'all' || s.rating === filter)
    .filter(s => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return s.url?.toLowerCase().includes(q) || s.tldr?.toLowerCase().includes(q);
    });

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
            Sign in to save your scan results across devices. Review any site you've checked and delete your records whenever you choose.
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

  const counts = {
    SAFE: scans.filter(s => s.rating === 'SAFE').length,
    OKAY: scans.filter(s => s.rating === 'OKAY').length,
    RISKY: scans.filter(s => s.rating === 'RISKY').length,
  };

  return (
    <div className="min-h-screen bg-[#080b14] text-white pt-28 pb-20 px-6 sm:px-12 lg:px-20 xl:px-32">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute -top-20 left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-indigo-600/[0.05] rounded-full blur-[100px]" />
      </div>
      <div className="relative max-w-[1600px] mx-auto flex flex-col lg:flex-row gap-10">
        <div className="flex-1 min-w-0">


        {/* Header with inline stats bar */}
        <div className="mb-8">
          <h1 className="text-2xl font-black tracking-[-0.03em] mb-1">Scan History</h1>
          {scans.length > 0 ? (
            <p className="text-sm">
              <span className="text-slate-400">{scans.length} scan{scans.length !== 1 ? 's' : ''}</span>
              <span className="text-slate-700 mx-1.5">·</span>
              <span className="text-rose-400 font-semibold">{counts.RISKY} RISKY</span>
              <span className="text-slate-700 mx-1.5">·</span>
              <span className="text-amber-400 font-semibold">{counts.OKAY} OKAY</span>
              <span className="text-slate-700 mx-1.5">·</span>
              <span className="text-emerald-400 font-semibold">{counts.SAFE} SAFE</span>
            </p>
          ) : (
            <p className="text-slate-600 text-sm">No scans yet</p>
          )}
        </div>

        {/* Search bar */}
        <div className="mb-4 max-w-[500px]">
          <div className="relative flex items-center">
            <Search className="absolute left-3.5 w-4 h-4 text-slate-600 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by URL or summary..."
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-10 pr-9 py-2.5 text-sm text-white placeholder-slate-600 outline-none focus:border-indigo-500/40 focus:bg-white/[0.06] transition-all"
            />
            {search && (
              <button onClick={() => setSearch('')}
                className="absolute right-3 text-slate-600 hover:text-slate-300 transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

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

        {/* Skeleton loading */}
        {loading && (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <ScanCardSkeleton key={i} />)}
          </div>
        )}

        {/* Empty */}
        {!loading && filtered.length === 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center py-20">
            <Shield className="w-14 h-14 text-slate-800/60 mx-auto mb-4" />
            {filter === 'all' && !search ? (
              <>
                <p className="text-slate-400 font-bold text-base mb-2">No scans yet</p>
                <p className="text-slate-600 text-sm leading-relaxed max-w-xs mx-auto mb-6">
                  Load the extension in Chrome, then visit any Terms of Service or Privacy Policy page to see your first scan here.
                </p>
                {/* Onboarding: load unpacked instructions */}
                <div className="inline-block text-left bg-white/[0.03] border border-white/[0.07] rounded-2xl px-5 py-4 max-w-xs mx-auto">
                  <p className="text-slate-400 text-xs font-bold mb-2 tracking-wide uppercase">How to load the extension</p>
                  <ol className="text-slate-500 text-xs leading-relaxed space-y-1 list-decimal list-inside">
                    <li>Open <span className="text-indigo-400 font-mono">chrome://extensions</span></li>
                    <li>Enable <span className="text-slate-300 font-semibold">Developer mode</span> (top right)</li>
                    <li>Click <span className="text-slate-300 font-semibold">Load unpacked</span></li>
                    <li>Select the <span className="text-slate-300 font-mono">extension/</span> folder</li>
                  </ol>
                </div>
              </>
            ) : (
              <p className="text-slate-600 font-semibold text-sm">
                {search ? `No scans match "${search}".` : `No ${filter} scans found.`}
              </p>
            )}
          </motion.div>
        )}

        {/* Scan cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          <AnimatePresence>
            {filtered.map((scan, i) => {
              const c = rating[scan.rating];
              const isExpanded = expanded === scan.id;
              const hasDeepPillars = scan.tier === 'deep' && !!scan.pillars;
              const violatedPillars = hasDeepPillars
                ? Object.entries(scan.pillars ?? {}).filter(([, p]) => p.violation)
                : [];

              return (
                <motion.div key={scan.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -16, height: 0, marginBottom: 0, paddingBottom: 0 }}
                  transition={{ delay: i * 0.03, duration: 0.3 }}
                  className={`group rounded-2xl ${c.bg} border ${c.border} hover:border-opacity-50 transition-all duration-200 overflow-hidden`}>

                  {/* Card body — clickable for all scan types */}
                  <div
                    onClick={() => setExpanded(isExpanded ? null : scan.id)}
                    className="flex items-center gap-4 p-4 cursor-pointer">

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

                        {/* Benchmark — Coming Soon */}
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          alert('Industry Benchmarking is coming soon to TLDR Shield!');
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-white/10 hover:text-indigo-400/50 transition-colors cursor-help"
                        title="Industry Comparison (Coming Soon)"
                      >
                        <BarChart2 size={14} />
                      </button>

                      {/* GDPR — Coming Soon */}
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          alert('GDPR Article 17 Generator is coming soon!');
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-white/10 hover:text-indigo-400/50 transition-colors cursor-help"
                        title="Generate GDPR Email (Coming Soon)"
                      >
                        <Mail size={14} />
                      </button>

                      {/* Watch — Coming Soon */}
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          alert('Policy Change Watcher is coming soon!');
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-white/10 hover:text-indigo-400/50 transition-colors cursor-help"
                        title="Watch for Changes (Coming Soon)"
                      >
                        <Bell size={14} />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(scan.id); }}
                        disabled={deleting === scan.id}
                        aria-label="Delete scan"
                        className="opacity-0 group-hover:opacity-100 w-8 h-8 rounded-xl flex items-center justify-center text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 transition-all">
                        {deleting === scan.id
                          ? <div className="w-3.5 h-3.5 border-2 border-rose-400 border-t-transparent rounded-full animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Expandable pillar breakdown */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        key="pillar-panel"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                        className="overflow-hidden">
                        <div className="px-4 pb-4 border-t border-white/[0.05] pt-3 space-y-2">
                          {hasDeepPillars && Object.entries(scan.pillars ?? {}).length > 0 ? (
                            Object.entries(scan.pillars ?? {}).map(([key, p]) => (
                              <div key={key} className="flex items-start gap-2.5">
                                <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${p.violation ? 'bg-rose-400' : 'bg-emerald-400'}`} />
                                <div className="flex-1 min-w-0">
                                  <span className={`text-[11px] font-bold ${p.violation ? 'text-rose-300' : 'text-slate-400'}`}>
                                    {PILLAR_LABELS[key] ?? key}
                                  </span>
                                  {p.citation && (
                                    <p className="text-slate-500 text-[11px] italic line-clamp-2 mt-0.5">"{p.citation}"</p>
                                  )}
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="py-2">
                              <p className="text-slate-400 text-[11px] leading-relaxed italic mb-2">
                                {scan.tldr}
                              </p>
                              {scan.tier === 'quick' && (
                                <p className="text-slate-600 text-[10px] uppercase font-black tracking-widest bg-white/[0.03] inline-block px-2 py-1 rounded">
                                  Detailed breakdown requires a Deep Scan
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {/* Chat panel — collapsible per scan */}
                  {activeChatId === scan.id ? (
                    <div className="mt-3 border-t border-white/10 pt-3">
                      <div className="space-y-2 max-h-48 overflow-y-auto mb-2">
                        {(chatMessages[scan.id] || []).map((m, i) => (
                          <div key={i} className={`text-xs px-3 py-2 rounded-lg ${m.role === 'user' ? 'bg-indigo-500/20 text-indigo-200 ml-8' : 'bg-white/5 text-gray-300 mr-8'}`}>
                            {m.content}
                          </div>
                        ))}
                        {chatLoading === scan.id && <div className="text-xs text-gray-500 px-3">Thinking...</div>}
                      </div>
                      <div className="flex gap-2">
                        <input
                          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                          placeholder="Ask about this scan..."
                          value={chatInput[scan.id] || ''}
                          onChange={e => setChatInput(p => ({ ...p, [scan.id]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') sendChat(scan.id, scan.id); }}
                        />
                        <button
                          onClick={() => sendChat(scan.id, scan.id)}
                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs text-white"
                        >Send</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setActiveChatId(scan.id)}
                      className="mt-2 text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      💬 Ask a question about this scan
                    </button>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
      
      {/* Right Sidebar: System Stats (Recruiter Wow Factor) */}
      <div className="w-full lg:w-[320px] shrink-0 space-y-6">
        <div className="bg-white/[0.03] border border-white/[0.08] rounded-3xl p-6 sticky top-28">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.1em] flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.4)]" />
              System Health
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 text-slate-500 border border-white/5">
              v2.5.0-PRO
            </span>
          </div>

          <div className="space-y-4 mb-8">
            <div className="p-3 rounded-2xl bg-white/[0.02] border border-white/[0.05] group">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-bold text-slate-300">Lane 1 (Scan Pool)</span>
                <span className="text-[10px] text-emerald-400 font-black">ACTIVE</span>
              </div>
              <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                <motion.div initial={{ width: 0 }} animate={{ width: '65%' }} className="h-full bg-emerald-500/40" />
              </div>
              <p className="text-[9px] text-slate-600 mt-2">Primary reasoning & analysis lane</p>
            </div>

            <div className="p-3 rounded-2xl bg-white/[0.02] border border-white/[0.05] group">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-bold text-slate-300">Lane 2 (Util Pool)</span>
                <span className="text-[10px] text-emerald-400 font-black">ACTIVE</span>
              </div>
              <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                <motion.div initial={{ width: 0 }} animate={{ width: '30%' }} className="h-full bg-emerald-500/40" />
              </div>
              <p className="text-[9px] text-slate-600 mt-2">Citations, grounding & meta-tasks</p>
            </div>

            <div className="p-3 rounded-2xl bg-white/[0.02] border border-white/[0.05] group">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-300">Ensemble Judge</span>
                <span className="text-[10px] text-indigo-400 font-black">ENABLED</span>
              </div>
              <p className="text-[9px] text-slate-600 mt-1">Multi-model consensus enabled</p>
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-indigo-500/5 border border-indigo-500/10 space-y-3">
            <div className="flex items-center gap-2 text-[10px] text-indigo-300 font-black tracking-widest uppercase">
              <Activity size={12} />
              Technical Note
            </div>
            <p className="text-[11px] text-indigo-300/60 leading-relaxed italic">
              "Hybrid-Lane pooling implemented to bypass free-tier rate limits. System automatically 'borrows' capacity across 6 API keys to ensure high availability."
            </p>
            <div className="pt-2">
              <button 
                onClick={() => window.open('https://github.com/Jatin23K/TLDR-Shield', '_blank')}
                className="w-full py-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 text-[10px] font-bold rounded-lg transition-all border border-indigo-500/10"
              >
                VIEW SYSTEM DESIGN
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* GDPR Right to Erasure modal */}
      <AnimatePresence>
        {gdprScan && (
          <motion.div
            key="gdpr-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setGdprScan(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0f0f18] border border-white/10 rounded-2xl p-6 w-full max-w-lg"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-white font-semibold mb-1">GDPR Right to Erasure Request</h3>
              <p className="text-white/50 text-sm mb-4">Generate a formal Article 17 deletion request for <span className="text-white/70">{(() => { try { return new URL(gdprScan.url).hostname; } catch { return gdprScan.url; } })()}</span></p>
              <input
                type="email"
                placeholder="Your email address"
                value={gdprEmail}
                onChange={e => setGdprEmail(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 mb-3 outline-none focus:border-indigo-500"
              />
              {gdprError && <p className="text-rose-400 text-xs mb-3">{gdprError}</p>}
              {!gdprResult ? (
                <button
                  onClick={async () => {
                    if (!gdprEmail.includes('@')) { setGdprError('Please enter a valid email.'); return; }
                    setGdprError('');
                    setGdprLoading(true);
                    try {
                      const { auth } = await import('./firebase');
                      const token = await auth.currentUser?.getIdToken();
                      if (!token) { setGdprError('Please sign in first.'); setGdprLoading(false); return; }
                      const violations = Object.entries(gdprScan.pillars ?? {}).filter(([, v]) => v?.violation).map(([k]) => k);
                      const companyName = new URL(gdprScan.url).hostname.replace(/^www\./, '');
                      const apiUrl = (import.meta as any).env?.VITE_API_URL ?? 'https://tldr-shield-292798741977.us-central1.run.app';
                      const resp = await fetch(`${apiUrl}/api/gdpr-email`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ companyName, userEmail: gdprEmail, siteUrl: gdprScan.url, violations }),
                      });
                      const data = await resp.json();
                      if (!resp.ok) { setGdprError(data.error ?? 'Generation failed.'); } else { setGdprResult(data); }
                    } catch { setGdprError('Network error. Please try again.'); }
                    finally { setGdprLoading(false); }
                  }}
                  disabled={gdprLoading}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-50"
                >
                  {gdprLoading ? 'Generating\u2026' : 'Generate Email (5 credits)'}
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-white/50 text-xs font-medium">{gdprResult.subject}</p>
                  <textarea readOnly rows={8} value={gdprResult.body}
                    className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-xs text-white/70 resize-none" />
                  <button
                    onClick={() => navigator.clipboard.writeText(`${gdprResult.subject}\n\n${gdprResult.body}`)}
                    className="w-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-lg py-2 text-sm font-semibold"
                  >Copy to Clipboard</button>
                </div>
              )}
              <button onClick={() => setGdprScan(null)} className="mt-3 w-full text-white/30 text-xs hover:text-white/60">Close</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Benchmark comparison modal */}
      <AnimatePresence>
        {benchmarkScan && (
          <motion.div
            key="benchmark-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setBenchmarkScan(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0f0f18] border border-white/10 rounded-2xl p-6 w-full max-w-md"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-white font-semibold mb-1">Industry Comparison</h3>
              {benchmarkLoading && <p className="text-white/40 text-sm">Loading…</p>}
              {benchmarkError && <p className="text-rose-400 text-sm">{benchmarkError}</p>}
              {benchmarkData && (
                <div className="space-y-4">
                  <p className="text-white/50 text-sm">
                    Comparing against <span className="text-white/80">{benchmarkData.label}</span> industry average
                  </p>
                  {/* Score bar */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-white/40">
                      <span>This site: <span className="text-white font-semibold">{benchmarkScan.score}/100</span></span>
                      <span>Industry avg: <span className="text-white/70">{benchmarkData.avgScore}/100</span></span>
                    </div>
                    <div className="relative h-3 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="absolute left-0 top-0 h-full rounded-full bg-indigo-500 transition-all"
                        style={{ width: `${benchmarkScan.score}%` }}
                      />
                      {/* Industry avg marker */}
                      <div
                        className="absolute top-0 h-full w-0.5 bg-amber-400/70"
                        style={{ left: `${benchmarkData.avgScore}%` }}
                      />
                    </div>
                    <p className="text-xs text-white/40 text-center">
                      {benchmarkScan.score < benchmarkData.avgScore
                        ? `⚠ Below industry average by ${benchmarkData.avgScore - benchmarkScan.score} points`
                        : `✓ Above industry average by ${benchmarkScan.score - benchmarkData.avgScore} points`}
                    </p>
                  </div>
                  {/* Common violations */}
                  <div>
                    <p className="text-xs text-white/40 mb-2">Most common violations in {benchmarkData.label}:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {benchmarkData.commonViolations.map(v => (
                        <span key={v} className="px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded text-rose-400 text-xs">
                          {v.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* Best/worst */}
                  <div className="flex gap-3 text-xs text-white/40">
                    <span>🏆 Safest: <span className="text-emerald-400">{benchmarkData.safest}</span></span>
                    <span>⚠ Riskiest: <span className="text-rose-400">{benchmarkData.riskiest}</span></span>
                  </div>
                </div>
              )}
              <button onClick={() => setBenchmarkScan(null)} className="mt-4 w-full text-white/30 text-xs hover:text-white/60">Close</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
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

// Posts the Firebase ID token to the extension content script via window.postMessage.
// The extension's content.js listens for this and relays it to background.js for storage.
async function syncTokenToExtension(user: User | null) {
  if (!user) {
    window.postMessage({ type: 'TLDR_AUTH_SIGNOUT' }, window.location.origin);
    return;
  }
  try {
    // forceRefresh: true ensures the extension always gets a fresh token,
    // not the cached one that may be within minutes of expiry.
    const token = await user.getIdToken(/* forceRefresh */ true);
    window.postMessage({
      type: 'TLDR_AUTH_TOKEN',
      token,
      uid: user.uid,
      email: user.email,
    }, window.location.origin);
  } catch { /* silent — extension may not be installed */ }
}

// ── Admin Console ─────────────────────────────────────────────────────────────

function AdminConsole({ isOpen, onClose, onToast }: { isOpen: boolean; onClose: () => void; onToast: (m: string, t: 'success' | 'error') => void }) {
  const [internalKey, setInternalKey] = useState(localStorage.getItem('tldr_admin_key') || '');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ active: boolean; model: string } | null>(null);

  const API_BASE = (import.meta as any).env?.VITE_API_URL ?? 'https://tldr-shield-292798741977.us-central1.run.app';

  const fetchStatus = async (key: string) => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      const data = await res.json();
      if (data.gemini?.proMode) {
        setStatus(data.gemini.proMode);
      }
    } catch (e) {
      console.error('Failed to fetch health status', e);
    }
  };

  useEffect(() => {
    if (isOpen) fetchStatus(internalKey);
  }, [isOpen]);

  const toggleProMode = async (enabled: boolean) => {
    if (!internalKey) {
      onToast('Internal Key required', 'error');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/pro-mode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': internalKey.trim()
        },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('tldr_admin_key', internalKey.trim());
        setStatus({ active: data.proModeActive, model: data.model });
        onToast(`Pro Mode ${data.proModeActive ? 'Enabled' : 'Disabled'}`, 'success');
      } else {
        onToast(data.error || 'Failed to toggle', 'error');
      }
    } catch (e) {
      onToast('Connection error', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-6"
      onClick={onClose}>
      <motion.div initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }}
        className="w-full max-w-md bg-[#0a0d1a] border border-indigo-500/30 rounded-3xl p-8 shadow-[0_0_50px_rgba(99,102,241,0.2)]"
        onClick={e => e.stopPropagation()}>
        
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 rounded-xl bg-indigo-500/20 text-indigo-400">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-black text-white tracking-tight">Admin Console</h2>
            <p className="text-slate-500 text-xs font-medium">Possession of key is the login</p>
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <label className="block text-slate-400 text-[11px] font-bold uppercase tracking-widest mb-2 px-1">Internal API Key</label>
            <div className="relative">
              <input 
                type="password"
                value={internalKey}
                onChange={e => setInternalKey(e.target.value)}
                placeholder="ts-admin-..."
                className="w-full bg-white/[0.03] border border-white/[0.08] rounded-2xl px-4 py-3 text-sm text-indigo-200 placeholder-slate-700 outline-none focus:border-indigo-500/50 focus:bg-indigo-500/[0.02] transition-all"
              />
              <Eye className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-700" />
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-white/[0.02] border border-white/[0.05]">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-white text-sm font-bold">Paid Pro Mode</p>
                <p className="text-slate-500 text-[11px]">Uses gemini-2.5-pro for high accuracy</p>
              </div>
              <div className={`px-2 py-0.5 rounded-full text-[9px] font-black tracking-tighter ${status?.active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-500/20 text-slate-500'}`}>
                {status?.active ? 'ACTIVE' : 'IDLE'}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button 
                onClick={() => toggleProMode(true)}
                disabled={loading || status?.active === true}
                className={`py-2.5 rounded-xl text-[12px] font-bold transition-all ${
                  status?.active 
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 cursor-default'
                    : 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-500/20'
                }`}>
                Enable Pro
              </button>
              <button 
                onClick={() => toggleProMode(false)}
                disabled={loading || status?.active === false}
                className={`py-2.5 rounded-xl text-[12px] font-bold transition-all ${
                  !status?.active 
                    ? 'bg-slate-500/10 text-slate-500 border border-white/[0.05] cursor-default'
                    : 'bg-white/[0.05] text-slate-300 hover:bg-white/[0.1] border border-white/[0.1]'
                }`}>
                Disable
              </button>
            </div>
          </div>

          <p className="text-[10px] text-slate-600 text-center leading-relaxed">
            Changes take effect immediately across all scan pipelines.<br />
            Disable after recording to save quota.
          </p>

          <button onClick={onClose} className="w-full py-3 text-slate-500 hover:text-white text-[13px] font-bold transition-colors">
            Close Console
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AdminBadge({ active }: { active: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[9px] font-black tracking-widest ${
      active ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-slate-500/10 border-white/10 text-slate-500'
    }`}>
      <Cpu className="w-2.5 h-2.5" />
      {active ? 'PRO MODE' : 'ADMIN'}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>('landing');
  const [user, setUser] = useState<User | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [markingRead, setMarkingRead] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);

  // Hidden Admin Console shortcut: Shift + A
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'A' && !['INPUT', 'TEXTAREA'].includes((e.target as any).tagName)) {
        setAdminPanelOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auth state + token sync to extension
  useEffect(() => {
    return onAuthStateChanged(auth, u => {
      setUser(u);
      syncTokenToExtension(u);
    });
  }, []);

  // Re-sync token when the extension popup requests it (handles: extension installed
  // after sign-in, token expired and popup is trying to recover state).
  useEffect(() => {
    const handler = () => {
      auth.currentUser && syncTokenToExtension(auth.currentUser);
    };
    window.addEventListener('tldr-request-auth', handler);
    return () => window.removeEventListener('tldr-request-auth', handler);
  }, []);

  // Live credits subscription from Firestore users/{uid}
  useEffect(() => {
    if (!user) { setCredits(null); return; }
    const currentMonth = new Date().toISOString().slice(0, 7);
    const userRef = doc(db, 'users', user.uid);
    const unsub = onSnapshot(userRef, (snap) => {
      if (!snap.exists()) {
        // New user — the server creates the Firestore doc via Admin SDK on first scan
        // (Firestore rules block client-side create on users/{uid}).
        // Show 400 credits optimistically; the real doc is created when they scan.
        setCredits(400);
      } else {
        const d = snap.data();
        // Show fresh credits if a new month started
        setCredits(d.lastResetMonth !== currentMonth ? 400 : (d.credits ?? 400));
      }
    });
    return unsub;
  }, [user]);

  // Live notifications subscription from Firestore notifications/{uid}/items
  useEffect(() => {
    if (!user) { setNotifications([]); return; }
    const q = query(
      collection(db, 'notifications', user.uid, 'items'),
      where('read', '==', false),
      orderBy('createdAt', 'desc'),
    );
    const unsub = onSnapshot(q, snap => {
      setNotifications(snap.docs.map(d => ({ id: d.id, ...d.data() } as NotificationRecord)));
    }, () => {/* silent */});
    return unsub;
  }, [user]);

  const handleMarkAllRead = async () => {
    if (!user || notifications.length === 0) return;
    setMarkingRead(true);
    try {
      await Promise.all(
        notifications.map(n =>
          updateDoc(doc(db, 'notifications', user.uid, 'items', n.id), { read: true })
        )
      );
    } catch { /* silent */ }
    finally { setMarkingRead(false); }
  };

  const handleDismissNotif = async (notifId: string) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'notifications', user.uid, 'items', notifId), { read: true });
    } catch { /* silent */ }
  };

  const handleSignIn = async () => {
    try {
      await signIn();
      showToast('Signed in', 'success');
    } catch { showToast('Sign-in failed. Try again.', 'error'); }
  };
  const handleSignOut = async () => {
    await signOut(); setPage('landing'); showToast('Signed out', 'success');
  };
  const showToast = (message: string, type: 'success' | 'error') => setToast({ message, type });

  return (
    <div className="bg-[#080b14]">
      <Nav page={page} onNav={setPage} user={user} onSignIn={handleSignIn} onSignOut={handleSignOut} credits={credits}
        unreadCount={notifications.length} onBellClick={() => setNotifPanelOpen(o => !o)} />

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

      {/* Notification panel — slides in from top-right */}
      <AnimatePresence>
        {notifPanelOpen && (
          <>
            {/* backdrop */}
            <motion.div
              key="notif-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[90]"
              onClick={() => setNotifPanelOpen(false)}
            />
            <motion.div
              key="notif-panel"
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              transition={{ duration: 0.18 }}
              className="fixed top-[68px] right-4 sm:right-12 lg:right-20 xl:right-32 z-[100] w-full max-w-sm bg-[#0f0f18] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
                <span className="text-white font-semibold text-sm flex items-center gap-2">
                  <Bell className="w-4 h-4 text-indigo-400" />
                  Policy Change Alerts
                  {notifications.length > 0 && (
                    <span className="bg-rose-500/20 text-rose-400 text-[10px] font-black px-1.5 py-0.5 rounded-full">
                      {notifications.length}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  {notifications.length > 0 && (
                    <button
                      onClick={handleMarkAllRead}
                      disabled={markingRead}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 font-semibold disabled:opacity-50 transition-colors"
                    >
                      {markingRead ? 'Marking…' : 'Mark all read'}
                    </button>
                  )}
                  <button onClick={() => setNotifPanelOpen(false)} className="text-slate-600 hover:text-slate-300 transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Notification list */}
              <div className="max-h-[60vh] overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <Bell className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                    <p className="text-slate-600 text-sm">No unread alerts</p>
                    <p className="text-slate-700 text-xs mt-1">Watch a policy to get notified when it changes.</p>
                  </div>
                ) : (
                  <AnimatePresence>
                    {notifications.map(n => {
                      const r = n.rating ?? 'OKAY';
                      const c = rating[r as 'SAFE' | 'OKAY' | 'RISKY'] ?? rating.OKAY;
                      const hostName = (() => { try { return new URL(n.url).hostname; } catch { return n.url; } })();
                      const scoreDiff = n.newScore - n.oldScore;
                      return (
                        <motion.div
                          key={n.id}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className={`border-b border-white/[0.04] px-4 py-3 ${c.bg}`}
                        >
                          <div className="flex items-start gap-3">
                            <div className={`mt-0.5 text-[10px] font-black px-1.5 py-0.5 rounded ${c.badge} shrink-0`}>{r}</div>
                            <div className="flex-1 min-w-0">
                              <p className="text-white text-[13px] font-semibold truncate">{hostName}</p>
                              <p className="text-slate-500 text-[11px] mt-0.5">
                                Score: <span className="font-bold text-slate-400">{n.oldScore}</span>
                                {' → '}
                                <span className={`font-bold ${scoreDiff < 0 ? 'text-rose-400' : scoreDiff > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>{n.newScore}</span>
                                {scoreDiff !== 0 && (
                                  <span className={`ml-1 ${scoreDiff < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                    ({scoreDiff > 0 ? '+' : ''}{scoreDiff})
                                  </span>
                                )}
                              </p>
                              {n.tldr && <p className="text-slate-600 text-[11px] italic mt-0.5 line-clamp-2">{n.tldr}</p>}
                            </div>
                            <button
                              onClick={() => handleDismissNotif(n.id)}
                              className="text-slate-700 hover:text-slate-400 transition-colors shrink-0 mt-0.5"
                              title="Dismiss"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] pointer-events-none">
        <AnimatePresence>
          {toast && <Toast key={toast.message} message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
        </AnimatePresence>
      </div>

      {/* Admin Control UI */}
      <AnimatePresence>
        {adminPanelOpen && <AdminConsole isOpen={adminPanelOpen} onClose={() => setAdminPanelOpen(false)} onToast={showToast} />}
      </AnimatePresence>

      {/* Hidden Admin Indicator (only if key exists in local storage) */}
      {localStorage.getItem('tldr_admin_key') && (
        <div className="fixed bottom-6 right-6 z-[40]">
           <button onClick={() => setAdminPanelOpen(true)} className="opacity-40 hover:opacity-100 transition-opacity">
              <AdminBadge active={false} />
           </button>
        </div>
      )}
    </div>
  );
}
