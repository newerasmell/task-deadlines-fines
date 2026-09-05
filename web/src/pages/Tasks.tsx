import { Fragment, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api, apiUpload, attachmentUrl } from "../api/client";
import { PRIORITY_LABELS, STATUS_LABELS } from "../api/types";
import type { Priority, Task, TaskSubmission, User } from "../api/types";
import { Avatar } from "../components/Avatar";
import { IconSearch } from "../components/icons";
import { RowMenu, RowMenuItem } from "../components/RowMenu";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";
import { colorForId } from "../lib/colors";
import { RecurringTasks } from "./RecurringTasks";

export const statusBadgeClass: Record<Task["status"], string> = {
  PENDING: "badge",
  IN_PROGRESS: "badge badge-info",
  PENDING_REVIEW: "badge badge-info",
  DONE: "badge badge-success",
  OVERDUE: "badge badge-danger",
  CANCELLED: "badge",
  BLOCKED: "badge",
};

const BOARD_COLUMNS: { status: Task["status"]; label: string; color: string; droppable: boolean }[] = [
  { status: "BLOCKED", label: "Чака проект", color: "#c4c4c4", droppable: false },
  { status: "PENDING", label: "Чакаща", color: "#9d99b9", droppable: true },
  { status: "IN_PROGRESS", label: "В процес", color: "#579bfc", droppable: true },
  { status: "PENDING_REVIEW", label: "За преглед", color: "#a25ddc", droppable: false },
  { status: "OVERDUE", label: "Просрочена", color: "#e2445c", droppable: true },
  { status: "DONE", label: "Завършена", color: "#00c875", droppable: true },
];

const PRIORITY_COLORS: Record<Priority, string> = {
  LOW: "#9d99b9",
  MEDIUM: "#579bfc",
  HIGH: "#fdab3d",
  CRITICAL: "#e2445c",
};

type ExpandedMode = "submit" | "review" | "edit" | null;
type Tab = "active" | "completed";
type ViewMode = "board" | "list" | "templates";

export function Tasks() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const isAdmin = user?.role === "ADMIN";
  const isLead = Boolean(user?.canAssignTasks);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showComplexForm, setShowComplexForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<{ taskId: string; mode: ExpandedMode } | null>(null);
  const [tab, setTab] = useState<Tab>("active");
  const [view, setView] = useState<ViewMode>(isAdmin ? "board" : "list");
  const [search, setSearch] = useState("");
  const [filterEmployee, setFilterEmployee] = useState("");
  const [filterPriority, setFilterPriority] = useState<Priority | "">("");
  const [filterStatus, setFilterStatus] = useState<Task["status"] | "">("");
  const [expandedDescIds, setExpandedDescIds] = useState<Set<string>>(new Set());

  function toggleDesc(id: string) {
    setExpandedDescIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function refresh() {
    const t = await api<Task[]>("/tasks");
    setTasks(t);
  }

  useEffect(() => {
    Promise.all([refresh(), api<User[]>("/users").then(setEmployees)]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startWork(id: string) {
    await api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "IN_PROGRESS" }) });
    refresh();
  }

  async function deleteTask(tk: Task) {
    if (!window.confirm(t('Наистина ли да изтрия "{title}"? Действието се записва в дневника.', { title: tk.title }))) return;
    await api(`/tasks/${tk.id}`, { method: "DELETE" });
    refresh();
  }

  async function completeTask(tk: Task) {
    if (!window.confirm(t('Да маркирам "{title}" като завършена? Прескача се преглед от Owner.', { title: tk.title }))) return;
    await api(`/tasks/${tk.id}/complete`, { method: "POST" });
    refresh();
  }

  function isLockedTask(tk: Task) {
    return tk.createdBy.isSuperAdmin && !user?.isSuperAdmin;
  }

  function toggleExpanded(taskId: string, mode: ExpandedMode) {
    setExpanded((cur) => (cur?.taskId === taskId && cur.mode === mode ? null : { taskId, mode }));
  }

  async function handleBoardStatusChange(taskId: string, status: Task["status"]) {
    await api(`/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status }) });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  const visibleTasks = tasks
    .filter((tk) => (tab === "completed" ? tk.status === "DONE" : tk.status !== "DONE"))
    .filter((tk) => !search || tk.title.toLowerCase().includes(search.toLowerCase()))
    .filter((tk) => !filterEmployee || tk.assigneeId === filterEmployee)
    .filter((tk) => !filterPriority || tk.priority === filterPriority)
    .filter((tk) => !filterStatus || tk.status === filterStatus);
  const expandedTask = expanded ? tasks.find((tk) => tk.id === expanded.taskId) : undefined;

  return (
    <div>
      <div className="page-header">
        <h1>{t("Задачи")}</h1>
        <div className="form-row" style={{ margin: 0 }}>
          {(isAdmin || isLead) && (
            <button
              className="secondary"
              onClick={() => {
                setShowComplexForm((s) => !s);
                setShowForm(false);
                setExpanded(null);
              }}
            >
              {showComplexForm ? t("Затвори") : t("+ Сложна задача")}
            </button>
          )}
          <button
            onClick={() => {
              setShowForm((s) => !s);
              setShowComplexForm(false);
              setExpanded(null);
            }}
          >
            {showForm ? t("Затвори") : t("+ Нова задача")}
          </button>
        </div>
      </div>

      {showForm && (
        <TaskForm
          employees={employees}
          onSaved={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      {showComplexForm && (
        <ComplexTaskForm
          employees={employees}
          onSaved={() => {
            setShowComplexForm(false);
            refresh();
          }}
          onCancel={() => setShowComplexForm(false)}
        />
      )}

      <div className="tabs">
        <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>
          {t("Табло")}
        </button>
        <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
          {t("Списък")}
        </button>
        <button className={view === "templates" ? "active" : ""} onClick={() => setView("templates")}>
          {t("Шаблони")}
        </button>
      </div>

      {view === "templates" ? (
        <RecurringTasks />
      ) : view === "board" ? (
        <>
          <TaskBoard
            tasks={tasks}
            currentUserId={user?.id}
            isAdmin={isAdmin}
            onEdit={(taskId) => toggleExpanded(taskId, "edit")}
            onStart={startWork}
            onSubmit={(taskId) => toggleExpanded(taskId, "submit")}
            onReview={(taskId) => toggleExpanded(taskId, "review")}
            onStatusChange={handleBoardStatusChange}
            onComplete={completeTask}
            isLockedTask={isLockedTask}
          />
          {expanded && expandedTask && expanded.mode === "edit" && isAdmin && (
            <TaskForm
              task={expandedTask}
              employees={employees}
              onSaved={() => {
                setExpanded(null);
                refresh();
              }}
              onCancel={() => setExpanded(null)}
            />
          )}
          {expanded && expandedTask && expanded.mode === "submit" && (
            <SubmitForm
              taskId={expanded.taskId}
              onDone={() => {
                setExpanded(null);
                refresh();
              }}
            />
          )}
          {expanded && expandedTask && expanded.mode === "review" && (
            <ReviewPanel
              taskId={expanded.taskId}
              onDone={() => {
                setExpanded(null);
                refresh();
              }}
            />
          )}
        </>
      ) : (
        <>
          <div className="tabs">
            <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>
              {t("Активни")}
            </button>
            <button className={tab === "completed" ? "active" : ""} onClick={() => setTab("completed")}>
              {t("Завършени")}
            </button>
          </div>

          <div className="filter-bar">
            <div className="search-input">
              <IconSearch size={16} />
              <input placeholder={t("Търсене по заглавие…")} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {isAdmin && (
              <select value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
                <option value="">{t("Всички служители")}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            )}
            <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value as Priority | "")}>
              <option value="">{t("Всички приоритети")}</option>
              {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {t(PRIORITY_LABELS[p])}
                </option>
              ))}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as Task["status"] | "")}>
              <option value="">{t("Всички статуси")}</option>
              {(Object.keys(STATUS_LABELS) as Task["status"][])
                .filter((s) => s !== "CANCELLED")
                .map((s) => (
                  <option key={s} value={s}>
                    {t(STATUS_LABELS[s])}
                  </option>
                ))}
            </select>
          </div>

          <div className="table-wrap">
          <div
            className="grid-table"
            style={{ gridTemplateColumns: "minmax(220px, 2fr) 150px 120px 160px 100px 110px 90px 56px" }}
          >
            <div className="grid-table-header">{t("Задача")}</div>
            <div className="grid-table-header">{t("Служител")}</div>
            <div className="grid-table-header">Owner</div>
            <div className="grid-table-header">{t("Срок")}</div>
            <div className="grid-table-header">{t("Приоритет")}</div>
            <div className="grid-table-header">{t("Статус")}</div>
            <div className="grid-table-header">{t("Глоби")}</div>
            <div className="grid-table-header"></div>

            {visibleTasks.map((tk) => {
              const activeFines = (tk.fines ?? []).filter((f) => f.status === "ACTIVE");
              const fineTotal = activeFines.reduce((s, f) => s + f.amount, 0);
              const isAssignee = tk.assigneeId === user?.id;
              const isOwner = tk.ownerId === user?.id;
              const canSubmit = isAssignee && (tk.status === "PENDING" || tk.status === "IN_PROGRESS" || tk.status === "OVERDUE");
              const canReview = (isOwner || isAdmin) && tk.status === "PENDING_REVIEW";
              const isExpanded = expanded?.taskId === tk.id;
              const locked = isLockedTask(tk);

              return (
                <Fragment key={tk.id}>
                  <div className="grid-row">
                    <div className="grid-cell" data-label={t("Задача")}>
                      <div
                        className="task-cell-clickable"
                        onClick={() => toggleDesc(tk.id)}
                        role="button"
                        tabIndex={0}
                        title={t("Покажи/скрий пълното описание")}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleDesc(tk.id);
                          }
                        }}
                      >
                        <div className={`cell-title${expandedDescIds.has(tk.id) ? " expanded" : ""}`}>
                          {tk.title}
                          {tk.templateId && (
                            <span className="badge" title={t("Повтаряща се задача")}>
                              ↻
                            </span>
                          )}
                          {tk.projectId && (
                            <span className="badge" title={t("Стъпка {order} от проект", { order: tk.chainOrder ?? "?" })}>
                              🔗 {tk.chainOrder}
                            </span>
                          )}
                          {isAdmin && locked && (
                            <span className="badge" title={t("Зададена от Ultimate Admin — само той може да я редактира/изтрие")}>
                              🔒
                            </span>
                          )}
                        </div>
                        <div className={`muted small cell-description${expandedDescIds.has(tk.id) ? " expanded" : ""}`}>
                          {tk.description}
                        </div>
                      </div>
                    </div>
                    <div className="grid-cell" data-label={t("Служител")}>
                      <Avatar id={tk.assigneeId} name={tk.assignee.name} size={22} />
                      {tk.assignee.name}
                    </div>
                    <div className="grid-cell" data-label="Owner">
                      {tk.owner?.name ?? "—"}
                    </div>
                    <div className="grid-cell" data-label={t("Срок")}>
                      {tk.status === "BLOCKED" ? (
                        <span className="muted">{t("Чака предходна стъпка")}</span>
                      ) : (
                        new Date(tk.deadline).toLocaleString(locale)
                      )}
                    </div>
                    <div className="grid-cell" data-label={t("Приоритет")}>
                      {t(PRIORITY_LABELS[tk.priority])}
                    </div>
                    <div className="grid-cell" data-label={t("Статус")}>
                      <span className={statusBadgeClass[tk.status]}>{t(STATUS_LABELS[tk.status])}</span>
                    </div>
                    <div className="grid-cell" data-label={t("Глоби")}>
                      {fineTotal > 0 ? `${fineTotal.toFixed(2)} ${activeFines[0].currency}` : "—"}
                    </div>
                    <div className="grid-cell grid-cell-actions">
                      <RowMenu label={t("Действия")}>
                        {isAssignee && tk.status === "PENDING" && (
                          <RowMenuItem onClick={() => startWork(tk.id)}>{t("Започни")}</RowMenuItem>
                        )}
                        {canSubmit && (
                          <RowMenuItem onClick={() => toggleExpanded(tk.id, "submit")}>
                            {isExpanded && expanded?.mode === "submit" ? t("Затвори") : t("Подай за преглед")}
                          </RowMenuItem>
                        )}
                        {canReview && (
                          <RowMenuItem onClick={() => toggleExpanded(tk.id, "review")}>
                            {isExpanded && expanded?.mode === "review" ? t("Затвори") : t("Прегледай")}
                          </RowMenuItem>
                        )}
                        {isAdmin && !locked && (
                          <RowMenuItem onClick={() => toggleExpanded(tk.id, "edit")}>
                            {isExpanded && expanded?.mode === "edit" ? t("Затвори") : t("Редактирай")}
                          </RowMenuItem>
                        )}
                        {isAdmin && !locked && tk.status !== "DONE" && tk.status !== "CANCELLED" && (
                          <RowMenuItem onClick={() => completeTask(tk)}>{t("Затвори като готова")}</RowMenuItem>
                        )}
                        {isAdmin && !locked && <RowMenuItem onClick={() => deleteTask(tk)}>{t("Изтрий")}</RowMenuItem>}
                      </RowMenu>
                    </div>
                  </div>
                  {isExpanded && expanded?.mode === "submit" && (
                    <div className="grid-cell-full">
                      <SubmitForm
                        taskId={tk.id}
                        onDone={() => {
                          setExpanded(null);
                          refresh();
                        }}
                      />
                    </div>
                  )}
                  {isExpanded && expanded?.mode === "review" && (
                    <div className="grid-cell-full">
                      <ReviewPanel
                        taskId={tk.id}
                        onDone={() => {
                          setExpanded(null);
                          refresh();
                        }}
                      />
                    </div>
                  )}
                  {isExpanded && expanded?.mode === "edit" && (
                    <div className="grid-cell-full">
                      <TaskForm
                        task={tk}
                        employees={employees}
                        onSaved={() => {
                          setExpanded(null);
                          refresh();
                        }}
                        onCancel={() => setExpanded(null)}
                      />
                    </div>
                  )}
                </Fragment>
              );
            })}
            {visibleTasks.length === 0 && (
              <div className="grid-cell-full muted">
                {tab === "completed" ? t("Няма завършени задачи.") : t("Няма активни задачи.")}
              </div>
            )}
          </div>
          </div>
        </>
      )}
    </div>
  );
}

function TaskBoard({
  tasks,
  currentUserId,
  isAdmin,
  onEdit,
  onStart,
  onSubmit,
  onReview,
  onStatusChange,
  onComplete,
  isLockedTask,
}: {
  tasks: Task[];
  currentUserId: string | undefined;
  isAdmin: boolean;
  onEdit: (taskId: string) => void;
  onStart: (taskId: string) => void;
  onSubmit: (taskId: string) => void;
  onReview: (taskId: string) => void;
  onStatusChange: (taskId: string, status: Task["status"]) => void;
  onComplete: (tk: Task) => void;
  isLockedTask: (tk: Task) => boolean;
}) {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggleCollapsed(empId: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(empId)) next.delete(empId);
      else next.add(empId);
      return next;
    });
  }

  const grouped = new Map<string, Task[]>();
  for (const tk of tasks) {
    if (tk.status === "CANCELLED") continue;
    const list = grouped.get(tk.assigneeId) ?? [];
    list.push(tk);
    grouped.set(tk.assigneeId, list);
  }
  const employeeIds = [...grouped.keys()].sort((a, b) =>
    grouped.get(a)![0].assignee.name.localeCompare(grouped.get(b)![0].assignee.name, "bg")
  );

  if (employeeIds.length === 0) return <p className="muted">{t("Няма задачи.")}</p>;

  // Admins can drag any (non-locked) card between any droppable column — it's
  // a raw status PATCH. Non-admins can only drag their OWN pending cards into
  // "В процес", the one status change PATCH /tasks/:id actually lets a plain
  // assignee make; every other transition (submit, approve, overdue) has its
  // own dedicated flow and isn't a valid drag target.
  function canDropInto(col: (typeof BOARD_COLUMNS)[number], draggedTask: Task | undefined): boolean {
    if (!draggedTask) return false;
    if (isAdmin) return col.droppable && !isLockedTask(draggedTask);
    return draggedTask.assigneeId === currentUserId && draggedTask.status === "PENDING" && col.status === "IN_PROGRESS";
  }

  return (
    <div className="board">
      {employeeIds.map((empId) => {
        const empTasks = grouped.get(empId)!;
        const color = colorForId(empId);
        const isCollapsed = collapsed.has(empId);
        return (
          <div className="board-group" key={empId} style={{ borderLeftColor: color }}>
            <div
              className="board-group-header board-group-header-clickable"
              onClick={() => toggleCollapsed(empId)}
              title={isCollapsed ? t("Разгъни") : t("Свий")}
            >
              <span className={`board-group-chevron${isCollapsed ? " board-group-chevron-collapsed" : ""}`}>▾</span>
              <span className="board-group-dot" style={{ background: color }} />
              <span style={{ color }}>{empTasks[0].assignee.name}</span>
              <span className="board-group-count">{empTasks.length}</span>
            </div>
            {!isCollapsed && (
            <div className="board-columns">
              {BOARD_COLUMNS.map((col) => {
                const colTasks = empTasks.filter((tk) => tk.status === col.status);
                const key = `${empId}:${col.status}`;
                const isDragOver = dragOverKey === key;
                return (
                  <div
                    key={col.status}
                    className={`board-column${isDragOver ? " board-column-over" : ""}`}
                    onDragOver={(e) => {
                      if (!dragTaskId) return;
                      const draggedTask = tasks.find((tk) => tk.id === dragTaskId);
                      if (!canDropInto(col, draggedTask)) return;
                      e.preventDefault();
                      setDragOverKey(key);
                    }}
                    onDragLeave={() => setDragOverKey((cur) => (cur === key ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverKey(null);
                      if (!dragTaskId) return;
                      const draggedTask = tasks.find((tk) => tk.id === dragTaskId);
                      if (!canDropInto(col, draggedTask)) return;
                      if (isAdmin) {
                        onStatusChange(dragTaskId, col.status);
                      } else {
                        onStart(dragTaskId);
                      }
                      setDragTaskId(null);
                    }}
                  >
                    <div className="board-column-header" style={{ borderTopColor: col.color }}>
                      {t(col.label)} <span className="muted small">({colTasks.length})</span>
                    </div>
                    <div className="board-column-body">
                      {colTasks.map((tk) => {
                        const activeFines = (tk.fines ?? []).filter((f) => f.status === "ACTIVE");
                        const fineTotal = activeFines.reduce((s, f) => s + f.amount, 0);
                        const locked = isLockedTask(tk);
                        const isAssignee = tk.assigneeId === currentUserId;
                        const isOwner = tk.ownerId === currentUserId;
                        const canStart = isAssignee && tk.status === "PENDING";
                        const canSubmitCard = isAssignee && (tk.status === "PENDING" || tk.status === "IN_PROGRESS" || tk.status === "OVERDUE");
                        const canReviewCard = (isOwner || isAdmin) && tk.status === "PENDING_REVIEW";
                        const canComplete = isAdmin && !locked && tk.status !== "DONE" && tk.status !== "CANCELLED";
                        const canClickToEdit = isAdmin && !locked;
                        const canDrag = isAdmin ? !locked : canStart;
                        return (
                          <div
                            key={tk.id}
                            className={`board-card${canDrag ? " board-card-clickable" : ""}`}
                            style={{ borderLeftColor: PRIORITY_COLORS[tk.priority] }}
                            draggable={canDrag}
                            onDragStart={() => canDrag && setDragTaskId(tk.id)}
                            onDragEnd={() => {
                              setDragTaskId(null);
                              setDragOverKey(null);
                            }}
                            onClick={() => canClickToEdit && onEdit(tk.id)}
                            title={
                              isAdmin
                                ? locked
                                  ? t("Зададена от Ultimate Admin — само той може да я редактира/изтрие")
                                  : t("Кликни за редакция")
                                : canStart
                                  ? t("Провлачи в „В процес“, за да започнеш")
                                  : undefined
                            }
                          >
                            <div className="board-card-title">
                              {tk.title}
                              {tk.templateId && <span title={t("Повтаряща се задача")}> ↻</span>}
                              {tk.projectId && <span title={t("Стъпка {order} от проект", { order: tk.chainOrder ?? "?" })}> 🔗{tk.chainOrder}</span>}
                              {isAdmin && locked && (
                                <span title={t("Зададена от Ultimate Admin — само той може да я редактира/изтрие")}> 🔒</span>
                              )}
                            </div>
                            <div className="board-card-meta muted small">
                              {tk.status === "BLOCKED"
                                ? t("Чака предходна стъпка")
                                : new Date(tk.deadline).toLocaleDateString(locale)}
                              {tk.owner && ` · Owner: ${tk.owner.name}`}
                            </div>
                            {fineTotal > 0 && (
                              <span className="badge badge-danger board-card-fine">
                                {fineTotal.toFixed(2)} {activeFines[0].currency}
                              </span>
                            )}
                            {(canStart || canSubmitCard || canReviewCard || canComplete) && (
                              <div className="board-card-actions">
                                {canStart && (
                                  <button
                                    className="small-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onStart(tk.id);
                                    }}
                                  >
                                    {t("Започни")}
                                  </button>
                                )}
                                {canSubmitCard && (
                                  <button
                                    className="small-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onSubmit(tk.id);
                                    }}
                                  >
                                    {t("Подай за преглед")}
                                  </button>
                                )}
                                {canReviewCard && (
                                  <button
                                    className="small-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onReview(tk.id);
                                    }}
                                  >
                                    {t("Прегледай")}
                                  </button>
                                )}
                                {canComplete && (
                                  <button
                                    className="small-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onComplete(tk);
                                    }}
                                  >
                                    {t("Затвори като готова")}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {colTasks.length === 0 && <div className="board-column-empty" />}
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SubmitForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const formData = new FormData();
      if (note) formData.append("note", note);
      if (files) Array.from(files).forEach((f) => formData.append("attachments", f));
      await apiUpload(`/tasks/${taskId}/submit`, formData);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <label>
        {t("Описание / обяснение на свършеното")}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder={t("Какво направи, къде е резултатът…")} />
      </label>
      <label>
        {t("Прикачи скрийншоти / снимки (по избор, до 5 файла)")}
        <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => setFiles(e.target.files)} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Изпращане…") : t("Подай за преглед")}
      </button>
    </form>
  );
}

export function ReviewPanel({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [task, setTask] = useState<Task | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<Task>(`/tasks/${taskId}`).then(setTask);
  }, [taskId]);

  if (!task) return <p className="muted">{t("Зареждане…")}</p>;

  const submission: TaskSubmission | undefined = task.submissions?.find((s) => s.reviewStatus === "PENDING");
  if (!submission) return <p className="muted">{t("Няма чакащо подаване.")}</p>;

  function buildFormData(extra: Record<string, string>) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(extra)) formData.append(key, value);
    if (files) Array.from(files).forEach((f) => formData.append("attachments", f));
    return formData;
  }

  async function approve() {
    setError(null);
    setSubmitting(true);
    try {
      await apiUpload(`/tasks/${taskId}/submissions/${submission!.id}/approve`, buildFormData(reviewNote ? { reviewNote } : {}));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!reviewNote.trim()) {
      setError(t("Обясни защо не одобряваш работата."));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiUpload(`/tasks/${taskId}/submissions/${submission!.id}/reject`, buildFormData({ reviewNote }));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card form">
      <p>
        <strong>{submission.submittedBy.name}</strong> {t("подаде на")} {new Date(submission.createdAt).toLocaleString(locale)}
      </p>
      {submission.note && <p>{submission.note}</p>}
      {submission.attachments.length > 0 && (
        <div className="attachment-grid">
          {submission.attachments.map((a) => {
            const url = attachmentUrl(taskId, submission.id, a.id);
            const isImage = a.mimeType.startsWith("image/");
            return isImage ? (
              <a key={a.id} href={url} target="_blank" rel="noreferrer">
                <img src={url} alt={a.originalName} className="attachment-thumb" />
              </a>
            ) : (
              <a key={a.id} href={url} target="_blank" rel="noreferrer" className="attachment-file">
                📄 {a.originalName}
              </a>
            );
          })}
        </div>
      )}
      <label>
        {t("Бележка при преглед (задължителна при отхвърляне)")}
        <textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={2} />
      </label>
      <label>
        {t("Прикачи файлове / снимки към прегледа (по избор, до 5 файла)")}
        <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => setFiles(e.target.files)} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="button" onClick={approve} disabled={submitting}>
          {t("Одобри")}
        </button>
        <button type="button" className="secondary" onClick={reject} disabled={submitting}>
          {t("Отхвърли")}
        </button>
      </div>
    </div>
  );
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TaskForm({
  task,
  employees,
  onSaved,
  onCancel,
}: {
  task?: Task;
  employees: User[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === "ADMIN";
  const isLead = Boolean(user?.canAssignTasks);
  const isEdit = Boolean(task);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [assigneeId, setAssigneeId] = useState(task?.assigneeId ?? (isAdmin ? employees[0]?.id ?? "" : user?.id ?? ""));
  const [ownerId, setOwnerId] = useState(task?.ownerId ?? "");
  const [deadline, setDeadline] = useState(task ? toLocalInputValue(task.deadline) : "");
  const originalDeadline = task ? toLocalInputValue(task.deadline) : "";
  const [deadlineChangeReason, setDeadlineChangeReason] = useState("");
  const [priority, setPriority] = useState<Priority>(task?.priority ?? "MEDIUM");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSelfAssign = !isEdit && assigneeId === user?.id;
  const isDeadlineChanged = isEdit && deadline !== originalDeadline;

  // A non-admin's `employees` list is already scoped by the server to just
  // {self, every Admin, their own Lead scope, other Leads} — Admins in that
  // list are excluded from the assignee options below UNLESS the Ultimate
  // Admin explicitly added that Admin to this Lead's own scope (e.g. so a
  // regular employee can be granted the right to assign tasks to the
  // Ultimate Admin specifically).
  const [ownScope, setOwnScope] = useState<string[]>([]);
  useEffect(() => {
    if (!isAdmin && isLead && user?.id) {
      api<string[]>(`/users/${user.id}/scope`).then(setOwnScope).catch(() => {});
    }
  }, [isAdmin, isLead, user?.id]);

  const assigneeOptions = useMemo(
    () =>
      isAdmin
        ? employees.filter((e) => e.active || e.id === assigneeId || e.id === ownerId)
        : employees.filter((e) => e.id === user?.id || e.role !== "ADMIN" || ownScope.includes(e.id)),
    [employees, assigneeId, ownerId, isAdmin, user?.id, ownScope]
  );
  const ownerOptions = useMemo(() => {
    const base = isAdmin
      ? employees.filter((e) => e.active || e.id === ownerId)
      : isSelfAssign
        ? employees.filter((e) => e.role === "ADMIN")
        : employees;
    return base.filter((e) => e.id !== assigneeId);
  }, [employees, assigneeId, ownerId, isAdmin, isSelfAssign]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!assigneeId) {
      setError(t("Избери служител."));
      return;
    }
    if (isSelfAssign && !ownerId) {
      setError(t("Самозададена задача трябва да има Owner — администратор, който да следи изпълнението."));
      return;
    }
    if (isDeadlineChanged && !deadlineChangeReason.trim()) {
      setError(t("Задължително е да опишеш причина за промяната на срока."));
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title,
        description: description || undefined,
        assigneeId,
        ownerId: ownerId || null,
        deadline: new Date(deadline).toISOString(),
        priority,
      };
      if (isDeadlineChanged) body.deadlineChangeReason = deadlineChangeReason.trim();
      if (isEdit) {
        await api(`/tasks/${task!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/tasks", { method: "POST", body: JSON.stringify({ ...body, ownerId: ownerId || undefined }) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <label>
        {t("Заглавие")}
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        {t("Описание")}
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>
      <div className="form-row">
        <label>
          {t("Служител")}
          {!isEdit && !isAdmin && !isLead ? (
            <input value={user?.name ?? ""} disabled />
          ) : (
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required disabled={isEdit && !isAdmin}>
              <option value="" disabled>
                {t("Избери…")}
              </option>
              {assigneeOptions.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.id === user?.id ? t("Ти") : emp.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          {t("Owner (проверява изпълнението)")}
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required={isSelfAssign}>
            {!isSelfAssign && <option value="">{t("Без — admin преглежда")}</option>}
            {isSelfAssign && (
              <option value="" disabled>
                {t("Избери администратор…")}
              </option>
            )}
            {ownerOptions.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
          {isSelfAssign && <span className="muted small">{t("Самозададена задача изисква администратор, който да следи изпълнението.")}</span>}
        </label>
        <label>
          {t("Срок")}
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} required />
        </label>
        <label>
          {t("Приоритет")}
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {t(PRIORITY_LABELS[p])}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isDeadlineChanged && (
        <div className="deadline-change-warning">
          <p>
            {t(
              "Задачи с променена дата/час ще бъдат прегледани от Ultimate Admin и ако се приеме за неоснователно, ще се наложи ръчна глоба!"
            )}
          </p>
          <label>
            {t("Причина за промяна на срока")}
            <input
              value={deadlineChangeReason}
              onChange={(e) => setDeadlineChangeReason(e.target.value)}
              required
              placeholder={t("Опиши защо се налага тази промяна…")}
            />
          </label>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : isEdit ? t("Запази промените") : t("Създай задача")}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            {t("Отказ")}
          </button>
        )}
      </div>
    </form>
  );
}

interface ComplexStepDraft {
  assigneeId: string;
  title: string;
  description: string;
  ownerId: string;
  priority: Priority;
  deadline: string; // datetime-local string — step 0 only
  delayDays: string; // step 1+ only
}

function emptyComplexStep(defaultAssigneeId: string): ComplexStepDraft {
  return { assigneeId: defaultAssigneeId, title: "", description: "", ownerId: "", priority: "MEDIUM", deadline: "", delayDays: "" };
}

// A "сложна задача": a chain of 2-4 task steps, each with its own
// assignee/owner. Step 1 gets a real deadline right away; every step after
// it only becomes active (a real deadline, visible in the normal flow) once
// the step before it is approved — see POST /projects and the
// activateNextChainStep() chain-activation block in the approve route.
function ComplexTaskForm({
  employees,
  onSaved,
  onCancel,
}: {
  employees: User[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === "ADMIN";
  const isLead = Boolean(user?.canAssignTasks);
  const [projectTitle, setProjectTitle] = useState("");
  const [steps, setSteps] = useState<ComplexStepDraft[]>([
    emptyComplexStep(isAdmin ? "" : (user?.id ?? "")),
    emptyComplexStep(""),
  ]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [ownScope, setOwnScope] = useState<string[]>([]);
  useEffect(() => {
    if (!isAdmin && isLead && user?.id) {
      api<string[]>(`/users/${user.id}/scope`).then(setOwnScope).catch(() => {});
    }
  }, [isAdmin, isLead, user?.id]);

  function assigneeOptionsFor(step: ComplexStepDraft) {
    return isAdmin
      ? employees.filter((e) => e.active || e.id === step.assigneeId || e.id === step.ownerId)
      : employees.filter((e) => e.id === user?.id || e.role !== "ADMIN" || ownScope.includes(e.id));
  }

  function ownerOptionsFor(step: ComplexStepDraft) {
    const isSelfAssign = step.assigneeId === user?.id;
    const base = isAdmin
      ? employees.filter((e) => e.active || e.id === step.ownerId)
      : isSelfAssign
        ? employees.filter((e) => e.role === "ADMIN")
        : employees;
    return base.filter((e) => e.id !== step.assigneeId);
  }

  function updateStep(index: number, patch: Partial<ComplexStepDraft>) {
    setSteps((cur) => cur.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function addStep() {
    setSteps((cur) => (cur.length >= 4 ? cur : [...cur, emptyComplexStep("")]));
  }

  function removeStep(index: number) {
    setSteps((cur) => (cur.length <= 2 ? cur : cur.filter((_, i) => i !== index)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.assigneeId) return setError(t("Избери служител за стъпка {n}.", { n: i + 1 }));
      if (!step.title) return setError(t("Въведи заглавие на задачата за стъпка {n}.", { n: i + 1 }));
      if (i === 0 && !step.deadline) return setError(t("Първата стъпка трябва да има краен срок."));
      if (i > 0 && !step.delayDays) return setError(t("Стъпка {n} трябва да има брой дни след предходната.", { n: i + 1 }));
      const isSelfAssign = step.assigneeId === user?.id;
      if (isSelfAssign && !isAdmin && !step.ownerId) {
        return setError(t('Стъпка {n} ("{title}") е самозададена и трябва да има Owner — администратор.', { n: i + 1, title: step.title }));
      }
    }

    setSubmitting(true);
    try {
      const body = {
        title: projectTitle,
        steps: steps.map((step, i) => ({
          assigneeId: step.assigneeId,
          title: step.title,
          description: step.description || undefined,
          ownerId: step.ownerId || undefined,
          priority: step.priority,
          deadline: i === 0 ? new Date(step.deadline).toISOString() : undefined,
          delayDays: i > 0 ? Number(step.delayDays) : undefined,
        })),
      };
      await api("/projects", { method: "POST", body: JSON.stringify(body) });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <label>
        {t("Име на проекта")}
        <input value={projectTitle} onChange={(e) => setProjectTitle(e.target.value)} required />
      </label>
      <p className="muted small">
        {t(
          "Верига от 2 до 4 задачи, всяка към различен служител. Първата стъпка тръгва веднага, а всяка следваща се активира едва след като предходната бъде одобрена — тогава срокът ѝ се пресмята автоматично (одобрение + брой дни). Всички участници получават известие за цялата верига веднага при създаването."
        )}
      </p>

      {steps.map((step, i) => {
        const isSelfAssign = step.assigneeId === user?.id;
        const assigneeOptions = assigneeOptionsFor(step);
        const ownerOptions = ownerOptionsFor(step);
        const ownerRequired = isSelfAssign && !isAdmin;
        return (
          <div className="card" key={i}>
            <div className="form-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <strong>{t("Стъпка {n}", { n: i + 1 })}</strong>
              {steps.length > 2 && (
                <button type="button" className="small-btn" onClick={() => removeStep(i)}>
                  {t("Премахни")}
                </button>
              )}
            </div>
            <label>
              {t("Задача")}
              <input value={step.title} onChange={(e) => updateStep(i, { title: e.target.value })} required />
            </label>
            <label>
              {t("Описание")}
              <textarea value={step.description} onChange={(e) => updateStep(i, { description: e.target.value })} rows={2} />
            </label>
            <div className="form-row">
              <label>
                {t("Служител")}
                <select value={step.assigneeId} onChange={(e) => updateStep(i, { assigneeId: e.target.value })} required>
                  <option value="" disabled>
                    {t("Избери…")}
                  </option>
                  {assigneeOptions.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.id === user?.id ? t("Ти") : emp.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("Owner (проверява изпълнението)")}
                <select value={step.ownerId} onChange={(e) => updateStep(i, { ownerId: e.target.value })} required={ownerRequired}>
                  {!ownerRequired && <option value="">{t("Без — admin преглежда")}</option>}
                  {ownerRequired && (
                    <option value="" disabled>
                      {t("Избери администратор…")}
                    </option>
                  )}
                  {ownerOptions.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("Приоритет")}
                <select value={step.priority} onChange={(e) => updateStep(i, { priority: e.target.value as Priority })}>
                  {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
                    <option key={p} value={p}>
                      {t(PRIORITY_LABELS[p])}
                    </option>
                  ))}
                </select>
              </label>
              {i === 0 ? (
                <label>
                  {t("Краен срок")}
                  <input type="datetime-local" value={step.deadline} onChange={(e) => updateStep(i, { deadline: e.target.value })} required />
                </label>
              ) : (
                <label>
                  {t("Дни след предходната стъпка")}
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={step.delayDays}
                    onChange={(e) => updateStep(i, { delayDays: e.target.value })}
                    required
                  />
                </label>
              )}
            </div>
          </div>
        );
      })}

      {steps.length < 4 && (
        <button type="button" className="secondary" onClick={addStep}>
          {t("+ Добави следваща стъпка")}
        </button>
      )}

      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : t("Създай проект")}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            {t("Отказ")}
          </button>
        )}
      </div>
    </form>
  );
}
