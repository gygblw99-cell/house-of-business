'use strict';

function paginated(res, { items, total, limit, offset }) {
  res.json({ items, total, limit, offset, hasMore: offset + items.length < total });
}

function success(res, data) {
  res.json(data);
}

function created(res, data) {
  res.status(201).json(data);
}

module.exports = { paginated, success, created };
