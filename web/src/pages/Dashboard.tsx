import { useEffect, useState } from "react";
import { api } from "../api/client";
import { STATUS_LABELS } from "../api/types";
import type { Fine, Task } from "../api/types";
import { useAuth } from "../context/AuthContext";

export function Dashboard() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [fines, setFines] = useState<Fine[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api<Task[]>("/tasks"), api<Fine[]>("/fines")])
      .then(([t, f]) => {
        setTasks(t);
        setFines(f);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Зареждане…</p>;

  const overdue = tasks.filter((t) => t.status === "OVERDUE");
  const dueSoon = tasks.filter((t) => {
    if (t.status !== "PENDING" && t.status !== "IN_PROGRESS") return false;
    const hours = (new Date(t.deadline).getTime() - Date.now()) / 3600000;
    return hours >= 0 && hours <= 48;
  });
  const activeFines = fines.filter((f) => f.status === "ACTIVE");
  const totalFines = activeFines.reduce((sum, f) => sum + f.amount, 0);

  return (
    <div>
      <h1>Табло</h1>
      <p className="muted">
        Здравей, {user?.name}. {user?.role === "ADMIN" ? "Ето текущото състояние на екипа." : "Ето твоите задачи и срокове."}
      </p>

      <div className="stat-grid">
        <div className="stat-card danger">
          <div className="stat-value">{overdue.length}</div>
          <div className="stat-label">Просрочени задачи</div>
        </div>
        <div className="stat-card warning">
          <div className="stat-value">{dueSoon.length}</div>
          <div className="stat-label">Наближаващи срокове (48ч)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {totalFines.toFixed(2)} {activeFines[0]?.currency ?? "BGN"}
          </div>
          <div className="stat-label">Активни глоби ({activeFines.length})</div>
        </div>
      </div>

      <h2>Просрочени задачи</h2>
      {overdue.length === 0 ? (
        <p className="muted">Няма просрочени задачи в момента.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Задача</th>
              <th>Служител</th>
              <th>Срок</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {overdue.map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td>{t.assignee.name}</td>
                <td>{new Date(t.deadline).toLocaleString("bg-BG")}</td>
                <td>
                  <span className="badge badge-danger">{STATUS_LABELS[t.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
