// Signing the studio in from a harness.
//
// The harnesses in this directory drive the real UI. When the studio is behind
// APP_PASSWORD — as it is when .env sets one — every one of them would otherwise
// land on the login page and fail on a selector that no longer exists.
//
// The password is read from the environment first and then .env, the same order
// the server uses. With no password configured the helper does nothing, so an
// open local studio behaves exactly as before.
const fs = require('fs');
const path = require('path');

function studioPassword() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = env.match(/^\s*APP_PASSWORD\s*=\s*(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

/**
 * Signs `page` in if the studio asks for a password. Safe to call unconditionally.
 * Returns true when it actually signed in.
 */
async function signIn(page, base) {
  const password = studioPassword();
  if (!password) return false;
  await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // No password field means the studio is already open (or already signed in).
  if (!(await page.$('input[name="password"]'))) return false;
  await page.type('input[name="password"]', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  return true;
}

/** Cookie header for harnesses that talk to /api/* with fetch instead of a page. */
async function apiCookie(base) {
  const password = studioPassword();
  if (!password) return '';
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(password),
    redirect: 'manual',
  });
  const raw = res.headers.get('set-cookie') || '';
  return raw ? raw.split(';')[0] : '';
}

module.exports = { signIn, apiCookie, studioPassword };
