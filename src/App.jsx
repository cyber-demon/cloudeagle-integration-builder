import { useState } from "react";

const STEPS = ["Input & Parse", "Configure", "Generate & Review", "Test & Deploy"];

const MOCK_PARSED = {
  name: "Calendly",
  version: "v2",
  baseUrl: "https://api.calendly.com",
  authType: "Bearer Token (OAuth 2.1 / Personal Access Token)",
  paginationType: "Cursor-based (next_page_token)",
  rateLimits: "Not explicitly documented — defaults applied (60 req/min)",
  endpoints: [
    { method: "GET", path: "/users/me", desc: "Get current user info", category: "Users", recommended: true },
    { method: "GET", path: "/organization_memberships", desc: "List organization members", category: "Users", recommended: true },
    { method: "GET", path: "/event_types", desc: "List event types", category: "License/Features", recommended: true },
    { method: "GET", path: "/scheduled_events", desc: "List scheduled events", category: "Usage", recommended: true },
    { method: "GET", path: "/scheduled_events/{uuid}/invitees", desc: "List event invitees", category: "Usage", recommended: true },
    { method: "GET", path: "/event_type_available_times", desc: "Get available times", category: "Availability", recommended: false },
    { method: "GET", path: "/user_busy_times", desc: "Get user busy times", category: "Availability", recommended: false },
  ],
};

const CODE_SECTIONS = {
  logging: {
    title: "Logging Setup",
    confidence: "high",
    lines: "1–12",
    code: `# ─── LOGGING ───────────────────────────────────────────
import logging

logger = logging.getLogger("cloudeagle.integrations.calendly")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter(
    "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
))
logger.addHandler(handler)`,
  },
  auth: {
    title: "Authentication (Bearer Token)",
    confidence: "high",
    lines: "14–32",
    code: `# ─── AUTH ──────────────────────────────────────────────
import os

class CalendlyAuth:
    """Handles Bearer token authentication.
    Credentials are injected via environment variables.
    NEVER hardcode tokens in this file."""
    
    def __init__(self):
        self.token = os.environ.get("CALENDLY_PAT")
        if not self.token:
            raise EnvironmentError(
                "CALENDLY_PAT environment variable is not set. "
                "Store your token in the credential vault."
            )
    
    def get_headers(self):
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }`,
  },
  client: {
    title: "API Client (Retry + Rate Limit + Circuit Breaker)",
    confidence: "medium",
    lines: "34–100",
    code: `# ─── API CLIENT ────────────────────────────────────────
import requests, time

class CalendlyClient:
    BASE_URL = "https://api.calendly.com"
    MAX_RETRIES = 3
    BACKOFF_FACTOR = 2
    RATE_LIMIT_PER_MIN = 60
    CIRCUIT_BREAKER_THRESHOLD = 5

    def __init__(self, auth):
        self.auth = auth
        self.session = requests.Session()
        self.session.headers.update(auth.get_headers())
        self._request_times = []
        self._consecutive_failures = 0

    def _check_circuit_breaker(self):
        if self._consecutive_failures >= self.CIRCUIT_BREAKER_THRESHOLD:
            raise ConnectionError("Circuit breaker OPEN")

    def _enforce_rate_limit(self):
        now = time.time()
        self._request_times = [t for t in self._request_times if now - t < 60]
        if len(self._request_times) >= self.RATE_LIMIT_PER_MIN:
            sleep_time = 60 - (now - self._request_times[0])
            logger.warning(f"Rate limit approaching. Sleeping {sleep_time:.1f}s")
            time.sleep(sleep_time)
        self._request_times.append(now)

    def request(self, method, endpoint, params=None):
        # READ-ONLY ENFORCEMENT
        if method.upper() not in ("GET", "HEAD"):
            raise PermissionError(f"Write operations ({method}) blocked.")
        
        self._check_circuit_breaker()
        self._enforce_rate_limit()
        url = f"{self.BASE_URL}{endpoint}"
        
        for attempt in range(self.MAX_RETRIES):
            try:
                resp = self.session.request(method, url, params=params)
                if resp.status_code == 429:
                    retry_after = int(resp.headers.get("Retry-After", 60))
                    time.sleep(retry_after)
                    continue
                if resp.status_code in (401, 403):
                    raise PermissionError(f"{resp.status_code} — check token")
                resp.raise_for_status()
                self._consecutive_failures = 0
                return resp.json()
            except requests.exceptions.RequestException as e:
                self._consecutive_failures += 1
                time.sleep(self.BACKOFF_FACTOR ** attempt)
        raise Exception(f"Failed after {self.MAX_RETRIES} retries")`,
  },
  retrieval: {
    title: "Data Retrieval with Pagination",
    confidence: "high",
    lines: "102–175",
    code: `# ─── DATA RETRIEVAL (with cursor pagination) ──────────
from datetime import datetime, timedelta

def get_current_user(client):
    data = client.request("GET", "/users/me")
    user = data.get("resource", {})
    logger.info(f"Current user: {user.get('name')}")
    return user

def get_organization_members(client, org_uri):
    members, params = [], {"organization": org_uri, "count": 100}
    while True:
        data = client.request("GET", "/organization_memberships", params=params)
        members.extend(data.get("collection", []))
        next_token = data.get("pagination", {}).get("next_page_token")
        if not next_token:
            break
        params["page_token"] = next_token
    logger.info(f"Total members: {len(members)}")
    return members

def get_scheduled_events(client, org_uri, days_back=30):
    events = []
    end = datetime.utcnow().isoformat() + "Z"
    start = (datetime.utcnow() - timedelta(days=days_back)).isoformat() + "Z"
    params = {
        "organization": org_uri,
        "min_start_time": start, "max_start_time": end,
        "count": 100, "status": "active",
    }
    while True:
        data = client.request("GET", "/scheduled_events", params=params)
        events.extend(data.get("collection", []))
        next_token = data.get("pagination", {}).get("next_page_token")
        if not next_token:
            break
        params["page_token"] = next_token
    logger.info(f"Total events: {len(events)}")
    return events

def get_event_types(client, org_uri):
    types, params = [], {"organization": org_uri, "count": 100}
    while True:
        data = client.request("GET", "/event_types", params=params)
        types.extend(data.get("collection", []))
        next_token = data.get("pagination", {}).get("next_page_token")
        if not next_token:
            break
        params["page_token"] = next_token
    logger.info(f"Total event types: {len(types)}")
    return types`,
  },
  sync: {
    title: "Main Sync Entrypoint",
    confidence: "high",
    lines: "177–220",
    code: `# ─── MAIN SYNC ENTRYPOINT ─────────────────────────────
def sync():
    """Called by CloudEagle scheduler."""
    logger.info("Starting Calendly sync...")
    
    auth = CalendlyAuth()
    client = CalendlyClient(auth)
    
    user = get_current_user(client)
    org_uri = user.get("current_organization")
    if not org_uri:
        raise ValueError("No organization found for this user")
    
    members = get_organization_members(client, org_uri)
    events = get_scheduled_events(client, org_uri, days_back=30)
    event_types = get_event_types(client, org_uri)
    
    result = {
        "source": "calendly",
        "sync_timestamp": datetime.utcnow().isoformat(),
        "data": {
            "users": members,
            "usage_events": events,
            "event_types": event_types,
        },
        "stats": {
            "total_users": len(members),
            "total_events": len(events),
            "total_event_types": len(event_types),
        }
    }
    logger.info(f"Sync complete: {len(members)} users, "
                f"{len(events)} events, {len(event_types)} event types")
    return result

if __name__ == "__main__":
    sync()`,
  },
};

const Badge = ({ children, color = "blue" }) => {
  const colors = {
    blue: "bg-blue-100 text-blue-800",
    green: "bg-green-100 text-green-800",
    yellow: "bg-yellow-100 text-yellow-800",
    red: "bg-red-100 text-red-800",
    gray: "bg-gray-100 text-gray-700",
    purple: "bg-purple-100 text-purple-800",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[color]}`}>
      {children}
    </span>
  );
};

export default function App() {
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState("https://developer.calendly.com/api-docs");
  const [inputMethod, setInputMethod] = useState("url");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);

  const [editAuthType, setEditAuthType] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editPagination, setEditPagination] = useState("");
  const [editingParsed, setEditingParsed] = useState(false);

  const [selectedEndpoints, setSelectedEndpoints] = useState([]);
  const [authMethod, setAuthMethod] = useState("pat");
  const [syncFreq, setSyncFreq] = useState("daily");
  const [dataScope, setDataScope] = useState("org");
  const [lang, setLang] = useState("python");
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});
  const [testPhase, setTestPhase] = useState("sandbox");
  const [sandboxDone, setSandboxDone] = useState(false);
  const [sandboxRunning, setSandboxRunning] = useState(false);
  const [stagingRunning, setStagingRunning] = useState(false);
  const [stagingDone, setStagingDone] = useState(false);
  const [reviewApproved, setReviewApproved] = useState(false);
  const [checklist, setChecklist] = useState({
    reviewed: false, readonly: false, vault: false, rate: false, alerting: false, rollback: false,
  });

  const handleParse = () => {
    setParsing(true);
    setTimeout(() => {
      setParsed(MOCK_PARSED);
      setEditAuthType(MOCK_PARSED.authType);
      setEditBaseUrl(MOCK_PARSED.baseUrl);
      setEditPagination(MOCK_PARSED.paginationType);
      setSelectedEndpoints(MOCK_PARSED.endpoints.filter(e => e.recommended).map(e => e.path));
      setParsing(false);
    }, 2000);
  };

  const handleGenerate = () => {
    setGenerating(true);
    setTimeout(() => { setGenerated(true); setGenerating(false); }, 3000);
  };

  const handleRunSandbox = () => {
    setSandboxRunning(true);
    setTimeout(() => { setSandboxDone(true); setSandboxRunning(false); }, 2500);
  };

  const handleRunStaging = () => {
    setStagingRunning(true);
    setTimeout(() => { setStagingDone(true); setStagingRunning(false); }, 3000);
  };

  const toggleEndpoint = (path) => {
    setSelectedEndpoints((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const allChecked = Object.values(checklist).every(Boolean);

  const sectionKeys = ["logging", "auth", "client", "retrieval", "sync"];

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm border p-5 mb-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-sm font-bold">CE</span>
            </div>
            <h1 className="text-lg font-bold text-gray-900">AI Integration Builder</h1>
            <Badge color="purple">Prototype</Badge>
          </div>
          <p className="text-sm text-gray-500 ml-11">Generate production-ready SaaS integrations from API documentation</p>
        </div>

        <div className="flex gap-1 mb-4">
          {STEPS.map((s, i) => (
            <button
              key={i}
              onClick={() => {
                if (i === 0 || (i === 1 && parsed) || (i === 2 && selectedEndpoints.length > 0) || (i === 3 && generated))
                  setStep(i);
              }}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-all ${
                step === i
                  ? "bg-blue-600 text-white shadow-sm"
                  : i < step
                  ? "bg-blue-100 text-blue-700 cursor-pointer"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              <span className="font-bold mr-1">{i + 1}.</span>{s}
            </button>
          ))}
        </div>

        {step === 0 && (
          <div className="bg-white rounded-xl shadow-sm border p-5">
            <h2 className="text-base font-bold mb-3">Provide API Documentation</h2>

            <div className="flex gap-2 mb-4">
              {[["url", "URL"], ["file", "OpenAPI File"], ["paste", "Paste Docs"]].map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setInputMethod(val)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    inputMethod === val ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-gray-50 border-gray-200 text-gray-600"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {inputMethod === "url" && (
              <div className="flex gap-2 mb-4">
                <input
                  type="text" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://developer.example.com/api-docs"
                  className="flex-1 px-3 py-2 border rounded-lg text-sm"
                />
                <button onClick={handleParse} disabled={parsing || !url}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                  {parsing ? "Parsing..." : "Parse Docs"}
                </button>
              </div>
            )}
            {inputMethod === "file" && (
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center mb-4">
                <p className="text-sm text-gray-500">Drop an OpenAPI/Swagger .json or .yaml file here</p>
                <button onClick={handleParse} className="mt-3 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                  {parsing ? "Parsing..." : "Use Sample (Calendly)"}
                </button>
              </div>
            )}
            {inputMethod === "paste" && (
              <div className="mb-4">
                <textarea placeholder="Paste API documentation here..." className="w-full h-32 px-3 py-2 border rounded-lg text-sm font-mono" />
                <button onClick={handleParse} className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                  {parsing ? "Parsing..." : "Parse"}
                </button>
              </div>
            )}

            {parsing && (
              <div className="bg-blue-50 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm font-medium text-blue-700">AI is analyzing the API documentation...</span>
                </div>
                <div className="text-xs text-blue-600 space-y-1">
                  <p>→ Fetching documentation page...</p>
                  <p>→ Extracting endpoints, auth model, and data structures...</p>
                </div>
              </div>
            )}

            {parsed && !parsing && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-green-600 font-bold">✓</span>
                    <span className="text-sm font-bold text-green-800">Successfully parsed: {parsed.name} API {parsed.version}</span>
                  </div>
                  <button
                    onClick={() => setEditingParsed(!editingParsed)}
                    className="text-xs text-blue-600 font-medium hover:underline"
                  >
                    {editingParsed ? "Done editing" : "Edit detections"}
                  </button>
                </div>

                {editingParsed ? (
                  <div className="space-y-2 mb-3">
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">Base URL</label>
                      <input value={editBaseUrl} onChange={e => setEditBaseUrl(e.target.value)}
                        className="w-full px-2 py-1.5 border rounded text-sm font-mono bg-white" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">Auth Type</label>
                      <select value={editAuthType} onChange={e => setEditAuthType(e.target.value)}
                        className="w-full px-2 py-1.5 border rounded text-sm bg-white">
                        <option value="Bearer Token (OAuth 2.1 / Personal Access Token)">Bearer Token (OAuth 2.1 / PAT)</option>
                        <option value="API Key (Header)">API Key (Header)</option>
                        <option value="API Key (Query Parameter)">API Key (Query Parameter)</option>
                        <option value="Basic Auth">Basic Auth</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">Pagination Type</label>
                      <select value={editPagination} onChange={e => setEditPagination(e.target.value)}
                        className="w-full px-2 py-1.5 border rounded text-sm bg-white">
                        <option value="Cursor-based (next_page_token)">Cursor-based (next_page_token)</option>
                        <option value="Offset-based (offset + limit)">Offset-based (offset + limit)</option>
                        <option value="Page-number-based (page + per_page)">Page-number-based (page + per_page)</option>
                        <option value="Link header (RFC 5988)">Link header (RFC 5988)</option>
                        <option value="None / Single page">None / Single page</option>
                      </select>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 text-xs mb-3">
                    <div><span className="text-gray-500">Base URL:</span> <code className="bg-white px-1 rounded">{editBaseUrl}</code></div>
                    <div><span className="text-gray-500">Auth:</span> <span className="font-medium">{editAuthType}</span></div>
                    <div><span className="text-gray-500">Pagination:</span> <span className="font-medium">{editPagination}</span></div>
                    <div><span className="text-gray-500">Rate Limits:</span> <span className="font-medium">{parsed.rateLimits}</span></div>
                    <div><span className="text-gray-500">Endpoints found:</span> <span className="font-bold text-blue-700">{parsed.endpoints.length}</span></div>
                  </div>
                )}

                <button onClick={() => setStep(1)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                  Confirm & Configure →
                </button>
              </div>
            )}
          </div>
        )}

        {step === 1 && parsed && (
          <div className="bg-white rounded-xl shadow-sm border p-5">
            <h2 className="text-base font-bold mb-3">Select Endpoints & Configure</h2>

            <div className="mb-4">
              <p className="text-xs text-gray-500 mb-2">
                AI-recommended endpoints are pre-selected based on CloudEagle&apos;s standard data model. Adjust as needed.
              </p>
              <div className="space-y-1.5">
                {parsed.endpoints.map((ep) => (
                  <label key={ep.path} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition ${
                    selectedEndpoints.includes(ep.path) ? "bg-blue-50 border-blue-200" : "bg-gray-50 border-gray-100"
                  }`}>
                    <input type="checkbox" checked={selectedEndpoints.includes(ep.path)}
                      onChange={() => toggleEndpoint(ep.path)} className="rounded" />
                    <Badge color={ep.method === "GET" ? "green" : "blue"}>{ep.method}</Badge>
                    <code className="text-xs font-mono">{ep.path}</code>
                    <span className="text-xs text-gray-500 ml-auto">{ep.desc}</span>
                    <Badge color="gray">{ep.category}</Badge>
                    {ep.recommended && <Badge color="blue">Recommended</Badge>}
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3 mb-4">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Auth Method</label>
                <select value={authMethod} onChange={e => setAuthMethod(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm">
                  <option value="pat">Personal Access Token</option>
                  <option value="oauth">OAuth 2.1</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Sync Frequency</label>
                <select value={syncFreq} onChange={e => setSyncFreq(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm">
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="manual">Manual</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Data Scope</label>
                <select value={dataScope} onChange={e => setDataScope(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm">
                  <option value="org">Organization-wide</option>
                  <option value="user">Per-user</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Output Language</label>
                <select value={lang} onChange={e => setLang(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm">
                  <option value="python">Python</option>
                  <option value="nodejs">Node.js</option>
                </select>
              </div>
            </div>

            <button onClick={() => { if (selectedEndpoints.length) setStep(2); }}
              disabled={!selectedEndpoints.length}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              Generate Integration Code →
            </button>
            <span className="ml-3 text-xs text-gray-400">{selectedEndpoints.length} endpoint(s) selected</span>
          </div>
        )}

        {step === 2 && (
          <div className="bg-white rounded-xl shadow-sm border p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-bold">Generated Integration Code</h2>
              {!generated && (
                <button onClick={handleGenerate} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                  {generating ? "Generating..." : "Generate Code"}
                </button>
              )}
            </div>

            {generating && (
              <div className="bg-blue-50 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm font-medium text-blue-700">AI is generating integration code...</span>
                </div>
                <div className="text-xs text-blue-600 space-y-1">
                  <p>→ Step 1/3: Parsing API schema into structured format...</p>
                  <p>→ Step 2/3: Planning data retrieval strategy...</p>
                  <p>→ Step 3/3: Generating auth, client, and sync modules...</p>
                </div>
              </div>
            )}

            {generated && (
              <>
                <div className="bg-gray-50 border rounded-lg p-3 mb-3">
                  <p className="text-xs font-bold text-gray-700 mb-1">🔒 Security Summary (AI-generated)</p>
                  <p className="text-xs text-gray-600">
                    This integration makes <strong>read-only GET requests</strong> to the Calendly API.
                    It uses Bearer token authentication (via environment variable — no hardcoded secrets).
                    It reads: organization members, scheduled events, and event types.
                    It writes nothing. Rate limited to 60 req/min with exponential backoff and circuit breaker.
                  </p>
                </div>

                <div className="space-y-2 mb-3">
                  {sectionKeys.map((key) => {
                    const sec = CODE_SECTIONS[key];
                    const isOpen = expandedSections[key];
                    return (
                      <div key={key} className="border rounded-lg overflow-hidden">
                        <button
                          onClick={() => setExpandedSections(p => ({ ...p, [key]: !p[key] }))}
                          className="w-full flex items-center justify-between p-2.5 text-left bg-white hover:bg-gray-50 transition"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">{isOpen ? "▼" : "▶"}</span>
                            <span className="text-sm font-medium">{sec.title}</span>
                            <Badge color={sec.confidence === "high" ? "green" : "yellow"}>
                              {sec.confidence} confidence
                            </Badge>
                          </div>
                          <span className="text-xs text-gray-400">Lines {sec.lines}</span>
                        </button>
                        {isOpen && (
                          <div className="border-t">
                            <pre className="bg-gray-900 text-green-400 p-3 text-xs font-mono overflow-auto max-h-64 leading-relaxed">
                              {sec.code}
                            </pre>
                            <div className="bg-gray-50 px-3 py-2 flex items-center justify-between">
                              <span className="text-xs text-gray-400">
                                {sec.confidence === "medium"
                                  ? "⚠ Rate limits not documented — conservative defaults applied. Review recommended."
                                  : "✓ Generated from explicit API documentation."}
                              </span>
                              <button type="button" className="text-xs text-blue-600 font-medium hover:underline">
                                Regenerate this section
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <button type="button" onClick={() => setStep(3)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                  Proceed to Testing →
                </button>
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="bg-white rounded-xl shadow-sm border p-5">
            <h2 className="text-base font-bold mb-3">Test & Deploy Pipeline</h2>

            <div className="flex gap-1 mb-4">
              {[
                ["sandbox", "1. Sandbox", true],
                ["staging", "2. Staging", sandboxDone],
                ["production", "3. Production", reviewApproved],
              ].map(([phase, label, enabled]) => (
                <button key={phase} type="button" onClick={() => enabled && setTestPhase(phase)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    testPhase === phase
                      ? "bg-blue-600 text-white border-blue-600"
                      : enabled
                      ? "bg-gray-50 border-gray-200 text-gray-700 cursor-pointer"
                      : "bg-gray-50 border-gray-100 text-gray-300"
                  }`}>
                  {label}
                </button>
              ))}
            </div>

            {testPhase === "sandbox" && (
              <div>
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-3">
                  <p className="text-xs font-medium text-yellow-800">
                    🧪 Sandbox — Code runs against <strong>mock API responses</strong> in an isolated container. No real credentials used.
                  </p>
                </div>
                {!sandboxDone && !sandboxRunning && (
                  <button type="button" onClick={handleRunSandbox}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                    Run Sandbox Tests
                  </button>
                )}
                {sandboxRunning && (
                  <div className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono space-y-0.5">
                    <p>$ docker run --rm --memory=512m --cpus=0.5 cloudeagle/sandbox calendly_integration.py</p>
                    <p className="text-gray-500">→ Loading mock API responses...</p>
                    <p className="text-gray-500">→ Testing auth setup... ✓</p>
                    <p className="text-gray-500">→ Testing pagination (3 pages)... ✓</p>
                    <p className="text-gray-500">→ Testing rate limiter... ✓</p>
                    <p className="text-gray-500">→ Testing error handling (429, 401, 500)... ✓</p>
                    <p className="text-gray-500">→ Checking for hardcoded credentials... ✓ None found</p>
                    <p className="text-gray-500">→ Validating read-only enforcement... ✓</p>
                    <p className="text-gray-500">→ Schema validation on mock responses... ✓</p>
                  </div>
                )}
                {sandboxDone && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                    <p className="text-sm font-bold text-green-800 mb-2">✓ All sandbox tests passed</p>
                    <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                      <div className="bg-white rounded p-2 text-center">
                        <p className="font-bold text-green-700">8/8</p><p className="text-gray-500">Tests passed</p>
                      </div>
                      <div className="bg-white rounded p-2 text-center">
                        <p className="font-bold text-green-700">0</p><p className="text-gray-500">Credential leaks</p>
                      </div>
                      <div className="bg-white rounded p-2 text-center">
                        <p className="font-bold text-green-700">Read-only</p><p className="text-gray-500">Access level</p>
                      </div>
                    </div>
                    <button type="button" onClick={() => setTestPhase("staging")} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                      Promote to Staging →
                    </button>
                  </div>
                )}
              </div>
            )}

            {testPhase === "staging" && (
              <div>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3">
                  <p className="text-xs font-medium text-blue-800">
                    🔬 Staging — Code runs against the <strong>real Calendly API</strong> with a single-user test token. Limited scope.
                  </p>
                </div>
                <div className="mb-3">
                  <label className="text-xs font-medium text-gray-600 block mb-1">Provide test token (single-user, least-privilege)</label>
                  <input type="password" placeholder="Enter Calendly PAT for staging test..."
                    className="w-full px-3 py-2 border rounded-lg text-sm" />
                  <p className="text-xs text-gray-400 mt-1">Token will be injected via vault. Not stored in code or logs.</p>
                </div>

                {!stagingDone && !stagingRunning && (
                  <button type="button" onClick={handleRunStaging}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                    Run Staging Test
                  </button>
                )}

                {stagingRunning && (
                  <div className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono space-y-0.5 mt-3">
                    <p>$ cloudeagle-runner --env=staging --target=calendly</p>
                    <p className="text-gray-500">→ Injecting credentials from vault...</p>
                    <p className="text-gray-500">→ Connecting to https://api.calendly.com...</p>
                    <p className="text-gray-500">→ GET /users/me ... 200 OK (124ms)</p>
                    <p className="text-gray-500">→ GET /organization_memberships?count=100 ... 200 OK (203ms)</p>
                    <p className="text-gray-500">→ Pagination: fetched 2 pages, 47 members total</p>
                    <p className="text-gray-500">→ GET /scheduled_events?count=100 ... 200 OK (189ms)</p>
                    <p className="text-gray-500">→ Pagination: fetched 3 pages, 218 events total</p>
                    <p className="text-gray-500">→ GET /event_types?count=100 ... 200 OK (98ms)</p>
                    <p className="text-gray-500">→ Schema validation against CloudEagle data model... ✓</p>
                    <p className="text-gray-500">→ Response shape matches expected structure... ✓</p>
                    <p className="text-green-400 font-bold mt-1">✓ Staging test complete — all checks passed</p>
                  </div>
                )}

                {stagingDone && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-3 mt-3">
                    <p className="text-sm font-bold text-green-800 mb-2">✓ Staging tests passed against live API</p>
                    <div className="grid grid-cols-4 gap-2 text-xs mb-3">
                      <div className="bg-white rounded p-2 text-center">
                        <p className="font-bold text-green-700">200 OK</p><p className="text-gray-500">All responses</p>
                      </div>
                      <div className="bg-white rounded p-2 text-center">
                        <p className="font-bold text-green-700">47</p><p className="text-gray-500">Users found</p>
                      </div>
                      <div className="bg-white rounded p-2 text-center">
                        <p className="font-bold text-green-700">218</p><p className="text-gray-500">Events synced</p>
                      </div>
                      <div className="bg-white rounded p-2 text-center">
                        <p className="font-bold text-green-700">✓</p><p className="text-gray-500">Schema valid</p>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs p-2 bg-white rounded-lg border mb-3 cursor-pointer">
                      <input type="checkbox" checked={reviewApproved} onChange={e => setReviewApproved(e.target.checked)} className="rounded" />
                      <span className="font-medium">I have reviewed the code and staging results. Approve for production.</span>
                    </label>
                    {reviewApproved && (
                      <button type="button" onClick={() => setTestPhase("production")} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium">
                        Promote to Production →
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {testPhase === "production" && (
              <div>
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
                  <p className="text-xs font-medium text-red-800">
                    🚀 Production — Complete the security checklist before deployment. All items are mandatory.
                  </p>
                </div>
                <div className="space-y-2 mb-4">
                  {[
                    ["reviewed", "Code reviewed and approved by authorized reviewer"],
                    ["readonly", "All endpoints are read-only (GET/HEAD only)"],
                    ["vault", "Credentials stored in vault (not in code or env files)"],
                    ["rate", "Rate limits configured and tested"],
                    ["alerting", "Alerting enabled for failures and circuit breaker trips"],
                    ["rollback", "Rollback procedure documented and tested"],
                  ].map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 p-2 rounded-lg bg-gray-50 cursor-pointer">
                      <input type="checkbox" checked={checklist[key]}
                        onChange={() => setChecklist(p => ({ ...p, [key]: !p[key] }))} className="rounded" />
                      <span className="text-xs">{label}</span>
                    </label>
                  ))}
                </div>
                <button type="button" disabled={!allChecked}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {allChecked ? "✓ Deploy to Production" : "Complete all checklist items"}
                </button>
                {allChecked && (
                  <p className="mt-2 text-xs text-green-700 font-medium">
                    ✓ Security checklist complete. Integration ready for production deployment.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
