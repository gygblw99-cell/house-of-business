'use strict';

// Small, domain-agnostic Gmail API helpers shared by gmail.fetch.service.js
// (Z-report attachment import) and gmail.deliveries.service.js (delivery
// body-text import) — both scan the same account for messages matching a
// date-bounded query, just with different search terms and message handling
// after that point.

// Format a Date as Gmail's `after:YYYY/MM/DD` search operator expects.
function dateToGmailAfter(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// List message IDs matching a query, paginating until maxResults is reached.
async function listMessages(gmail, query, maxResults = 1000) {
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me', q: query, maxResults: Math.min(100, maxResults - ids.length), pageToken,
    });
    (res.data.messages || []).forEach(m => ids.push(m.id));
    pageToken = res.data.nextPageToken;
  } while (pageToken && ids.length < maxResults);
  return ids;
}

module.exports = { dateToGmailAfter, listMessages };
