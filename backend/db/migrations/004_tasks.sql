-- Migration 004: Tasks & Subtasks
-- הרצה: psql -U hob_user -d house_of_business -f backend/db/migrations/004_tasks.sql

-- טבלת משימות ראשיות
CREATE TABLE IF NOT EXISTS tasks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,   -- NULL = כל העובדים
    title           TEXT NOT NULL,
    description     TEXT,
    priority        TEXT NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low','normal','high','urgent')),
    status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','in_progress','done','cancelled')),
    due_date        DATE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- טבלת תת-משימות (כל אחת מצריכה צילום לאחר ביצוע)
CREATE TABLE IF NOT EXISTS task_subtasks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','done')),
    completed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    completion_photo TEXT,                         -- נתיב/URL לתמונת האחרי
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_business ON tasks(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_subtasks_task  ON task_subtasks(task_id);
