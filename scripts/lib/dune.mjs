// Minimal Dune API client: execute a saved query with parameters, wait, read all rows.
// Docs: https://docs.dune.com/api-reference/executions/endpoint/execute-query

const BASE = 'https://api.dune.com/api/v1';
const POLL_MS = 5000;
const TIMEOUT_MS = 30 * 60 * 1000;
const PAGE = 10000;

export async function runQuery({ apiKey, queryId, params, performance = 'medium', log = console.log }) {
  const headers = { 'X-Dune-API-Key': apiKey, 'Content-Type': 'application/json' };

  const exec = await call(`${BASE}/query/${queryId}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query_parameters: params, performance }),
  });
  const id = exec.execution_id;
  log(`dune: execution ${id} started`);

  const started = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    const status = await call(`${BASE}/execution/${id}/status`, { headers });
    if (status.state === 'QUERY_STATE_COMPLETED') break;
    if (status.is_execution_finished) {
      throw new Error(`dune: execution ${id} ended in ${status.state}: ${JSON.stringify(status.error ?? '')}`);
    }
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`dune: execution ${id} timed out`);
  }

  const rows = [];
  let offset = 0;
  for (;;) {
    const page = await call(`${BASE}/execution/${id}/results?limit=${PAGE}&offset=${offset}`, { headers });
    rows.push(...(page.result?.rows ?? []));
    if (page.next_offset == null) break;
    offset = page.next_offset;
  }
  log(`dune: ${rows.length} rows`);
  return rows;
}

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`dune: ${res.status} ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
