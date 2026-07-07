import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "../lib/api";
import { TaskDetail } from "./TaskDetail";

const COLUMNS = [
  { id: "pending_approval", labelKey: "statusPendingApproval", color: "border-amber-400", bg: "bg-amber-50/50", noDrag: true },
  { id: "todo", labelKey: "statusTodo", color: "border-gray-300", bg: "bg-gray-50", noDrag: false },
  { id: "in_progress", labelKey: "statusInProgress", color: "border-blue-400", bg: "bg-blue-50/50", noDrag: false },
  { id: "in_review", labelKey: "statusInReview", color: "border-purple-400", bg: "bg-purple-50/50", noDrag: false },
  { id: "done", labelKey: "statusDone", color: "border-green-400", bg: "bg-green-50/50", noDrag: false },
  { id: "blocked", labelKey: "statusBlocked", color: "border-red-400", bg: "bg-red-50/50", noDrag: false },
] as const;

interface Task {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  verification_id: string | null;
  verification_verdict?: string | null;
  verification_severity?: string | null;
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  tasks: Task[];
  agents: Agent[];
  onUpdate?: () => void;
}

function SortableCard({
  task,
  agents,
  onCardClick,
  noDrag = false,
}: {
  task: Task;
  agents: Agent[];
  onCardClick: (taskId: string) => void;
  noDrag?: boolean;
}) {
  const { t } = useTranslation();
  const agent = agents.find((a) => a.id === task.assignee_id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id, data: { task }, disabled: noDrag });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(noDrag ? {} : attributes)}
      className="bg-white border border-gray-200 rounded-lg px-3 py-2.5 shadow-sm hover:shadow dark:bg-gray-800 dark:border-gray-700 group relative"
    >
      {/* Drag handle area — only drag listener here (skipped for noDrag columns) */}
      {!noDrag && (
        <div
          {...listeners}
          className="absolute inset-0 cursor-grab active:cursor-grabbing rounded-lg"
        />
      )}
      {/* Clickable content above drag layer */}
      <div
        role="button"
        tabIndex={0}
        aria-label={task.title}
        className="relative z-10"
        onClick={(e) => { e.stopPropagation(); onCardClick(task.id); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCardClick(task.id); } }}
      >
        <div className="text-sm text-gray-800 dark:text-gray-200 mb-1.5 line-clamp-2">{task.title}</div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {agent && (
            <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-gray-500 dark:text-gray-400 truncate max-w-[120px]">
              {agent.name}
            </span>
          )}
          {task.verification_verdict ? (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
              task.verification_verdict === "pass"
                ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                : task.verification_verdict === "fail"
                ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400"
            }`}>
              {task.verification_verdict === "pass" ? t("verdictPass") : task.verification_verdict === "fail" ? t("verdictFail") : t("verdictConditional")}
            </span>
          ) : task.verification_id ? (
            <span className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400 rounded">
              {t("verified")}
            </span>
          ) : null}
          {task.status === "pending_approval" && (
            <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-medium">
              {t("statusPendingApproval")}
            </span>
          )}
          {(task.title ?? "").startsWith("[사전 조사]") && (
            <span className="text-[10px] px-1.5 py-0.5 bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-400 rounded-full">
              {t("adversarialBadge")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskCard({ task, agents }: { task: Task; agents: Agent[] }) {
  const agent = agents.find((a) => a.id === task.assignee_id);
  return (
    <div className="bg-white border border-blue-300 rounded-lg px-3 py-2.5 shadow-md dark:bg-gray-800">
      <div className="text-sm text-gray-800 dark:text-gray-200 mb-1">{task.title}</div>
      {agent && (
        <span className="text-[10px] text-gray-400">{agent.name}</span>
      )}
    </div>
  );
}

const KANBAN_DONE_PREVIEW = 5;

function groupByStatus(tasks: Task[]): Record<string, Task[]> {
  return tasks.reduce<Record<string, Task[]>>((acc, task) => {
    if (!acc[task.status]) acc[task.status] = [];
    acc[task.status].push(task);
    return acc;
  }, {});
}

export function KanbanBoard({ tasks, agents, onUpdate }: KanbanBoardProps) {
  const { t } = useTranslation();
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  const groupedTasks = useMemo(() => groupByStatus(tasks), [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === event.active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    // Determine target column — over could be a column or another task
    let targetStatus: string;

    // Check if dropped on a column
    const column = COLUMNS.find((c) => c.id === over.id);
    if (column) {
      targetStatus = column.id;
    } else {
      // Dropped on another task — use that task's status
      const overTask = tasks.find((t) => t.id === over.id);
      if (!overTask) return;
      targetStatus = overTask.status;
    }

    const currentTask = tasks.find((t) => t.id === taskId);
    if (!currentTask || currentTask.status === targetStatus) return;

    // pending_approval column is read-only — approval only via button
    if (targetStatus === "pending_approval") return;

    // Update task status
    await api.tasks.update(taskId, { status: targetStatus });
    onUpdate?.();
  };

  return (
    <>
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          agents={agents}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={() => { setSelectedTaskId(null); onUpdate?.(); }}
        />
      )}
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4">
        {COLUMNS.map((col) => {
          const columnTasks = groupedTasks[col.id] ?? [];
          const isDone = col.id === "done";
          const visibleTasks = isDone && !showAllDone && columnTasks.length > KANBAN_DONE_PREVIEW
            ? columnTasks.slice(0, KANBAN_DONE_PREVIEW)
            : columnTasks;
          const hiddenCount = columnTasks.length - visibleTasks.length;

          return (
            <div
              key={col.id}
              className={`flex-shrink-0 w-[220px] rounded-lg border-t-2 ${col.color} ${col.bg} dark:bg-gray-900/50`}
            >
              <div className="px-3 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  {t(col.labelKey)}
                </span>
                <span className="text-[10px] text-gray-300 dark:text-gray-600">
                  {columnTasks.length}
                </span>
              </div>

              <SortableContext
                id={col.id}
                items={visibleTasks.map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="px-2 pb-2 space-y-2 min-h-[60px] max-h-[calc(100vh-280px)] overflow-y-auto">
                  {visibleTasks.map((task) => (
                    <SortableCard
                      key={task.id}
                      task={task}
                      agents={agents}
                      onCardClick={setSelectedTaskId}
                      noDrag={col.noDrag}
                    />
                  ))}
                  {columnTasks.length === 0 && (
                    <div className="text-[10px] text-gray-300 dark:text-gray-600 text-center py-4">
                      {t("dropHere")}
                    </div>
                  )}
                  {isDone && columnTasks.length > KANBAN_DONE_PREVIEW && (
                    <button
                      onClick={() => setShowAllDone((v) => !v)}
                      aria-label={showAllDone ? t("showLessDone") : t("showMoreDone", { count: hiddenCount })}
                      className="w-full text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 py-1 text-center transition-colors"
                    >
                      {showAllDone
                        ? t("showLessDone")
                        : t("showMoreDone", { count: hiddenCount })}
                    </button>
                  )}
                </div>
              </SortableContext>
            </div>
          );
        })}
      </div>

      <DragOverlay>
        {activeTask ? <TaskCard task={activeTask} agents={agents} /> : null}
      </DragOverlay>
    </DndContext>
    </>
  );
}
