import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import './App.css'

const YEAR_OPTIONS = [2026, 2027, 2028, 2029, 2030]
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEK_POSITIONS = ['First Week', 'Second Week', 'Third Week', 'Fourth Week', 'Fifth Week']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const STORAGE_KEY = 'my-task-planner-data'
const STORAGE_VERSION = 1

type TaskType = 'temporary' | 'permanent'

type Task = {
  id: string
  title: string
  type: TaskType
  dateKey?: string
  recurrenceKey?: string
  exceptions: Record<string, boolean>
  completionByDate: Record<string, boolean>
}

type DayCard = {
  dateKey: string
  label: string
  weekIndex: number
  weekday: string
}

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.random() * 16 | 0
    const value = character === 'x' ? random : (random & 0x3 | 0x8)
    return value.toString(16)
  })
}

function buildSampleTasks(): Task[] {
  return [
    {
      id: 'sample-monthly-quality-review',
      title: 'Monthly Quality Review',
      type: 'permanent',
      recurrenceKey: 'First Week|Saturday',
      exceptions: {},
      completionByDate: {},
    },
    {
      id: 'sample-weekly-planning',
      title: 'Weekly Planning',
      type: 'permanent',
      recurrenceKey: 'First Week|Monday',
      exceptions: {},
      completionByDate: {},
    },
    {
      id: 'sample-kpi-review',
      title: 'KPI Review',
      type: 'permanent',
      recurrenceKey: 'Second Week|Wednesday',
      exceptions: {},
      completionByDate: {},
    },
    {
      id: 'sample-monthly-report',
      title: 'Monthly Report',
      type: 'permanent',
      recurrenceKey: 'Fourth Week|Thursday',
      exceptions: {},
      completionByDate: {},
    },
    {
      id: 'sample-prepare-presentation',
      title: 'Prepare Presentation',
      type: 'temporary',
      dateKey: '2026-09-19',
      exceptions: {},
      completionByDate: {},
    },
    {
      id: 'sample-check-emails',
      title: 'Check Emails',
      type: 'temporary',
      dateKey: '2026-09-20',
      exceptions: {},
      completionByDate: {},
    },
  ]
}

type DbTaskRow = {
  id: string
  title: string
  type: TaskType
  task_date: string | null
  recurrence_week: string | null
  recurrence_day: string | null
}

type DbExceptionRow = {
  task_id: string
  exception_date: string
  action: string
}

type DbCompletionRow = {
  task_id: string
  occurrence_date: string
  completed: boolean
}

function encodeWorkSlot(slotKey: string) {
  const match = slotKey.match(/^work:(\d{4})-(\d{2}):w([1-5]):d([1-7])$/)
  if (!match) {
    return null
  }

  const [, year, month, week, day] = match
  const encodedYear =
    2100 + (Number(year) - 2026) * 60 + (Number(month) - 1) * 5 + Number(week) - 1
  return `${encodedYear}-01-${day.padStart(2, '0')}`
}

function decodeStoredWorkSlot(storedValue: string | null) {
  if (!storedValue) {
    return undefined
  }

  const match = storedValue.match(/^(\d{4})-01-0([1-7])$/)
  if (!match) {
    return storedValue
  }

  const [, encodedYear, day] = match
  const encodedOffset = Number(encodedYear) - 2100
  if (encodedOffset < 0) {
    return storedValue
  }

  const appYear = 2026 + Math.floor(encodedOffset / 60)
  const monthSlot = encodedOffset % 60
  const monthIndex = Math.floor(monthSlot / 5)
  const weekIndex = monthSlot % 5
  return getWorkSlotKey(appYear, monthIndex, weekIndex, Number(day) - 1)
}

function readTasksFromLocalStorage(): Task[] {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) {
      const sampleTasks = buildSampleTasks()
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: STORAGE_VERSION, tasks: sampleTasks }),
      )
      return sampleTasks
    }

    const parsed = JSON.parse(saved)
    if (parsed && Array.isArray(parsed.tasks)) {
      return parsed.tasks
    }

    if (Array.isArray(parsed)) {
      return parsed
    }

    const sampleTasks = buildSampleTasks()
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, tasks: sampleTasks }),
    )
    return sampleTasks
  } catch {
    return buildSampleTasks()
  }
}

async function loadTasksFromSupabase(): Promise<Task[]> {
  const [{ data: taskRows, error: taskError }, { data: exceptionRows, error: exceptionError }, { data: completionRows, error: completionError }] = await Promise.all([
    supabase.from('tasks').select('id, title, type, task_date, recurrence_week, recurrence_day'),
    supabase.from('task_exceptions').select('task_id, exception_date, action'),
    supabase.from('task_completions').select('task_id, occurrence_date, completed'),
  ])

  if (taskError || exceptionError || completionError) {
    throw new Error('Supabase sync failed')
  }

  const taskMap = new Map<string, Task>()

  ;(taskRows ?? []).forEach((row: DbTaskRow) => {
    const task: Task = {
      id: row.id,
      title: row.title,
      type: row.type,
      dateKey: row.type === 'temporary' ? decodeStoredWorkSlot(row.task_date) : undefined,
      recurrenceKey:
        row.type === 'permanent' && row.recurrence_week && row.recurrence_day
          ? `${row.recurrence_week}|${row.recurrence_day}`
          : undefined,
      exceptions: {},
      completionByDate: {},
    }

    taskMap.set(task.id, task)
  })

  ;(exceptionRows ?? []).forEach((row: DbExceptionRow) => {
    const task = taskMap.get(row.task_id)
    if (!task) {
      return
    }

    const exceptionKey = decodeStoredWorkSlot(row.exception_date)
    if (exceptionKey) {
      task.exceptions[exceptionKey] = true
    }
  })

  ;(completionRows ?? []).forEach((row: DbCompletionRow) => {
    const task = taskMap.get(row.task_id)
    if (!task || !row.completed) {
      return
    }

    const completionKey = decodeStoredWorkSlot(row.occurrence_date)
    if (completionKey) {
      task.completionByDate[completionKey] = true
    }
  })

  return Array.from(taskMap.values())
}

async function syncTasksToSupabase(tasks: Task[]) {
  const { data: existingTaskRows, error: existingTasksError } = await supabase
    .from('tasks')
    .select('id')

  if (existingTasksError) {
    throw existingTasksError
  }

  const taskIds = new Set(tasks.map((task) => task.id))
  const deletedTaskIds = (existingTaskRows ?? [])
    .map((row) => row.id)
    .filter((taskId) => !taskIds.has(taskId))

  if (deletedTaskIds.length > 0) {
    const { error: deleteExceptionsError } = await supabase
      .from('task_exceptions')
      .delete()
      .in('task_id', deletedTaskIds)

    if (deleteExceptionsError) {
      throw deleteExceptionsError
    }

    const { error: deleteCompletionsError } = await supabase
      .from('task_completions')
      .delete()
      .in('task_id', deletedTaskIds)

    if (deleteCompletionsError) {
      throw deleteCompletionsError
    }

    const { error: deleteTasksError } = await supabase
      .from('tasks')
      .delete()
      .in('id', deletedTaskIds)

    if (deleteTasksError) {
      throw deleteTasksError
    }
  }

  const taskRows = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    type: task.type,
    task_date: task.type === 'temporary' && task.dateKey ? encodeWorkSlot(task.dateKey) : null,
    recurrence_week:
      task.type === 'permanent' && task.recurrenceKey ? task.recurrenceKey.split('|')[0] : null,
    recurrence_day:
      task.type === 'permanent' && task.recurrenceKey ? task.recurrenceKey.split('|')[1] : null,
  }))

  const { error: taskError } = await supabase.from('tasks').upsert(taskRows, { onConflict: 'id' })
  if (taskError) {
    throw taskError
  }

  const exceptionRows = tasks.flatMap((task) =>
    Object.entries(task.exceptions)
      .filter(([, enabled]) => enabled)
      .map(([date]) => ({
        task_id: task.id,
        exception_date: encodeWorkSlot(date) ?? date,
        action: 'hidden',
      })),
  )

  const completionRows = tasks.flatMap((task) =>
    Object.entries(task.completionByDate)
      .filter(([, completed]) => completed)
      .map(([date]) => ({
        task_id: task.id,
        occurrence_date: encodeWorkSlot(date) ?? date,
        completed: true,
      })),
  )

  if (taskIds.size > 0) {
    const { error: deleteExceptionsError } = await supabase
      .from('task_exceptions')
      .delete()
      .in('task_id', Array.from(taskIds))

    if (deleteExceptionsError) {
      throw deleteExceptionsError
    }

    const { error: deleteCompletionsError } = await supabase
      .from('task_completions')
      .delete()
      .in('task_id', Array.from(taskIds))

    if (deleteCompletionsError) {
      throw deleteCompletionsError
    }
  }

  if (exceptionRows.length > 0) {
    const { error: exceptionError } = await supabase.from('task_exceptions').upsert(exceptionRows, {
      onConflict: 'task_id,exception_date',
    })

    if (exceptionError) {
      throw exceptionError
    }
  }

  if (completionRows.length > 0) {
    const { error: completionError } = await supabase.from('task_completions').upsert(completionRows, {
      onConflict: 'task_id,occurrence_date',
    })

    if (completionError) {
      throw completionError
    }
  }

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, tasks }))
  }
}

async function deleteTaskFromSupabase(task: Task, dateKey: string, mode: 'temporary' | 'permanent') {
  if (task.type === 'permanent' && mode === 'temporary') {
    const { error } = await supabase.from('task_exceptions').upsert(
      {
        task_id: task.id,
        exception_date: encodeWorkSlot(dateKey) ?? dateKey,
        action: 'hidden',
      },
      { onConflict: 'task_id,exception_date' },
    )

    if (error) {
      throw error
    }

    return
  }

  const { error: deleteExceptionsError } = await supabase
    .from('task_exceptions')
    .delete()
    .eq('task_id', task.id)

  if (deleteExceptionsError) {
    throw deleteExceptionsError
  }

  const { error: deleteCompletionsError } = await supabase
    .from('task_completions')
    .delete()
    .eq('task_id', task.id)

  if (deleteCompletionsError) {
    throw deleteCompletionsError
  }

  const { data: deletedTasks, error: deleteTaskError } = await supabase
    .from('tasks')
    .delete()
    .eq('id', task.id)
    .select('id')

  if (deleteTaskError) {
    throw deleteTaskError
  }

  if (!deletedTasks || deletedTasks.length !== 1) {
    throw new Error('The task was not deleted. Check the Supabase DELETE policy for tasks.')
  }
}

function getAvailableMonthsForYear(year: number) {
  return year === 2026 ? [8, 9, 10, 11] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
}

function getWorkSlotKey(year: number, monthIndex: number, weekIndex: number, dayIndex: number) {
  return `work:${year}-${String(monthIndex + 1).padStart(2, '0')}:w${weekIndex + 1}:d${dayIndex + 1}`
}

function getWeekDates(year: number, monthIndex: number, weekIndex: number): DayCard[] {
  return Array.from({ length: 7 }, (_, index) => {
    return {
      dateKey: getWorkSlotKey(year, monthIndex, weekIndex, index),
      label: WEEKDAY_NAMES[index],
      weekIndex,
      weekday: WEEKDAY_NAMES[index],
    }
  })
}

function isTaskCompleted(task: Task, dateKey: string) {
  return Boolean(task.completionByDate[dateKey])
}

function getVisibleTasksForSlot(day: DayCard, tasks: Task[]) {
  return tasks.filter((task) => {
    if (task.type === 'temporary') {
      return task.dateKey === day.dateKey
    }

    if (!task.recurrenceKey) {
      return false
    }

    const isMatchingRecurrence = task.recurrenceKey === `${WEEK_POSITIONS[day.weekIndex]}|${day.weekday}`
    const isTemporarilyRemoved = Boolean(task.exceptions[day.dateKey])

    return isMatchingRecurrence && !isTemporarilyRemoved
  })
}

function App() {
  const [year, setYear] = useState(2026)
  const [monthIndex, setMonthIndex] = useState(8)
  const [weekIndex, setWeekIndex] = useState(0)
  const [tasks, setTasks] = useState<Task[]>([])
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false)
  const [selectedDateKey, setSelectedDateKey] = useState('')
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskType, setNewTaskType] = useState<TaskType>('temporary')
  const [deleteTarget, setDeleteTarget] = useState<{ task: Task; dateKey: string } | null>(null)
  const [editTarget, setEditTarget] = useState<{ task: Task; dateKey: string } | null>(null)
  const [editedTaskTitle, setEditedTaskTitle] = useState('')
  const [editMode, setEditMode] = useState<'occurrence' | 'all'>('all')
  const [addTaskError, setAddTaskError] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const hasLoadedTasksRef = useRef(false)
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    let isMounted = true

    const load = async () => {
      try {
        const nextTasks = await loadTasksFromSupabase()
        if (isMounted) {
          setTasks(nextTasks)
          hasLoadedTasksRef.current = true
        }
      } catch {
        const fallbackTasks = readTasksFromLocalStorage()
        if (isMounted) {
          setTasks(fallbackTasks)
          hasLoadedTasksRef.current = true
        }
      }
    }

    load()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!hasLoadedTasksRef.current) {
      return
    }

    syncQueueRef.current = syncQueueRef.current
      .catch(() => undefined)
      .then(() => syncTasksToSupabase(tasks))
      .catch(() => {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, tasks }))
        }
      })
  }, [tasks])

  const monthOptions = useMemo(() => getAvailableMonthsForYear(year), [year])
  const visibleWeekIndex = Math.min(weekIndex, 4)
  const weekDates = useMemo(() => getWeekDates(year, monthIndex, visibleWeekIndex), [year, monthIndex, visibleWeekIndex])

  const handleYearSelect = (nextYear: number) => {
    setYear(nextYear)
    setWeekIndex(0)

    if (nextYear === 2026) {
      setMonthIndex(8)
      return
    }

    setMonthIndex(0)
  }

  const handleMonthSelect = (nextMonthIndex: number) => {
    setMonthIndex(nextMonthIndex)
    setWeekIndex(0)
  }

  const goHome = () => {
    setYear(2026)
    setMonthIndex(8)
    setWeekIndex(0)
  }

  const goToday = () => {
    const todayDate = new Date()
    const currentYear = todayDate.getFullYear()
    const currentMonth = todayDate.getMonth()

    if (currentYear < 2026 || currentYear > 2030) {
      goHome()
      return
    }

    setYear(currentYear)
    setMonthIndex(currentMonth)
    setWeekIndex(0)
  }

  const goBack = () => {
    const currentIndex = monthOptions.indexOf(monthIndex)

    if (weekIndex > 0) {
      setWeekIndex(weekIndex - 1)
      return
    }

    if (currentIndex > 0) {
      setMonthIndex(monthOptions[currentIndex - 1])
      setWeekIndex(4)
      return
    }

    const currentYearIndex = YEAR_OPTIONS.indexOf(year)
    if (currentYearIndex > 0) {
      const previousYear = YEAR_OPTIONS[currentYearIndex - 1]
      handleYearSelect(previousYear)
    }
  }

  const openAddTaskModal = (dateKey: string) => {
    setSelectedDateKey(dateKey)
    setNewTaskTitle('')
    setNewTaskType('temporary')
    setAddTaskError('')
    setIsTaskModalOpen(true)
  }

  const closeAddTaskModal = () => {
    setIsTaskModalOpen(false)
    setSelectedDateKey('')
    setNewTaskTitle('')
    setNewTaskType('temporary')
    setAddTaskError('')
  }

  const handleAddTask = () => {
    const trimmedTitle = newTaskTitle.trim()
    if (!trimmedTitle || !selectedDateKey) {
      return
    }

    const selectedDay = weekDates.find((day) => day.dateKey === selectedDateKey)
    if (!selectedDay) {
      return
    }

    const recurrenceKey = `${WEEK_POSITIONS[selectedDay.weekIndex]}|${selectedDay.weekday}`
    const duplicateRecurring =
      newTaskType === 'permanent' &&
      tasks.some(
        (task) =>
          task.type === 'permanent' &&
          task.title.toLowerCase() === trimmedTitle.toLowerCase() &&
          task.recurrenceKey === recurrenceKey,
      )

    if (duplicateRecurring) {
      setAddTaskError('A matching recurring task already exists for this week and weekday.')
      return
    }

    const task: Task = {
      id: createId(),
      title: trimmedTitle,
      type: newTaskType,
      dateKey: newTaskType === 'temporary' ? selectedDateKey : undefined,
      recurrenceKey:
        newTaskType === 'permanent' ? recurrenceKey : undefined,
      exceptions: {},
      completionByDate: {},
    }

    setTasks((previousTasks) => [...previousTasks, task])
    closeAddTaskModal()
  }

  const toggleTaskCompletion = (taskId: string, dateKey: string) => {
    setTasks((previousTasks) =>
      previousTasks.map((task) => {
        if (task.id !== taskId) {
          return task
        }

        const nextCompleted = !isTaskCompleted(task, dateKey)

        return {
          ...task,
          completionByDate: {
            ...task.completionByDate,
            [dateKey]: nextCompleted,
          },
        }
      }),
    )
  }

  const handleDeleteTask = async (mode: 'temporary' | 'permanent') => {
    if (!deleteTarget) {
      return
    }

    const { task, dateKey } = deleteTarget
    setDeleteError('')
    setIsDeleting(true)

    try {
      syncQueueRef.current = syncQueueRef.current
        .catch(() => undefined)
        .then(() => deleteTaskFromSupabase(task, dateKey, mode))
      await syncQueueRef.current

      setTasks((previousTasks) => {
        if (task.type === 'temporary' || mode === 'permanent') {
          return previousTasks.filter((item) => item.id !== task.id)
        }

        return previousTasks.map((item) =>
          item.id === task.id
            ? { ...item, exceptions: { ...item.exceptions, [dateKey]: true } }
            : item,
        )
      })

      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete the task.')
    } finally {
      setIsDeleting(false)
    }
  }

  const openEditModal = (task: Task, dateKey: string) => {
    setEditedTaskTitle(task.title)
    setEditMode(task.type === 'permanent' ? 'all' : 'occurrence')
    setEditTarget({ task, dateKey })
  }

  const handleSaveEdit = () => {
    if (!editTarget) {
      return
    }

    const { task, dateKey } = editTarget
    const trimmedTitle = editedTaskTitle.trim()

    if (!trimmedTitle) {
      return
    }

    setTasks((previousTasks) => {
      if (task.type === 'temporary') {
        return previousTasks.map((item) => {
          if (item.id !== task.id) {
            return item
          }

          return {
            ...item,
            title: trimmedTitle,
          }
        })
      }

      if (editMode === 'all') {
        return previousTasks.map((item) => {
          if (item.id !== task.id) {
            return item
          }

          return {
            ...item,
            title: trimmedTitle,
          }
        })
      }

      return [
        ...previousTasks,
        {
          ...task,
          id: createId(),
          title: trimmedTitle,
          type: 'temporary',
          dateKey,
          recurrenceKey: undefined,
          completionByDate: {
            ...task.completionByDate,
            [dateKey]: Boolean(task.completionByDate[dateKey]),
          },
        },
      ]
    })

    setEditTarget(null)
    setEditedTaskTitle('')
  }

  return (
    <div className="planner-app">
      <aside className="side-panel">
        <div className="nav-section">
          <h2>Years</h2>
          <div className="year-grid">
            {YEAR_OPTIONS.map((yearOption) => (
              <button
                key={yearOption}
                type="button"
                className={yearOption === year ? 'nav-button active' : 'nav-button'}
                onClick={() => handleYearSelect(yearOption)}
              >
                {yearOption}
              </button>
            ))}
          </div>
        </div>

        <div className="nav-section">
          <h2>Months</h2>
          <div className="month-grid">
            {monthOptions.map((month) => (
              <button
                key={month}
                type="button"
                className={month === monthIndex ? 'nav-button active' : 'nav-button'}
                onClick={() => handleMonthSelect(month)}
              >
                {MONTH_NAMES[month]}
              </button>
            ))}
          </div>
        </div>

      </aside>

      <main className="calendar-panel">
        <header className="calendar-header">
          <div className="header-main">
            <div>
              <span className="eyebrow">My Task Planner</span>
              <h1>{MONTH_NAMES[monthIndex]} {year}</h1>
            </div>
            <div className="header-actions">
              <button type="button" className="secondary-button small" onClick={goToday}>
                Today
              </button>
              <button type="button" className="secondary-button small" onClick={goBack}>
                Back
              </button>
              <button type="button" className="secondary-button small" onClick={goHome}>
                Home
              </button>
            </div>
          </div>
          <nav className="breadcrumbs" aria-label="Breadcrumb navigation">
            <button type="button" className="breadcrumb-link" onClick={goHome}>
              Years
            </button>
            <span>›</span>
            <button type="button" className="breadcrumb-link" onClick={() => setYear(year)}>
              {year}
            </button>
            <span>›</span>
            <button type="button" className="breadcrumb-link" onClick={() => handleMonthSelect(monthIndex)}>
              {MONTH_NAMES[monthIndex]}
            </button>
            <span>›</span>
            <span>{WEEK_POSITIONS[visibleWeekIndex]}</span>
          </nav>
        </header>

        <div className="month-week-selector" aria-label="Week selection">
          {WEEK_POSITIONS.map((label, index) => (
            <button
              key={label}
              type="button"
              className={index === visibleWeekIndex ? 'nav-button active' : 'nav-button'}
              onClick={() => setWeekIndex(index)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="day-grid">
          {weekDates.map((day) => {
            const visibleTasks = getVisibleTasksForSlot(day, tasks)

            return (
              <section
                key={day.dateKey}
                className="day-card"
              >
                <div className="day-header">
                  <div>
                    <p className="day-name">{day.label}</p>
                  </div>
                  <button type="button" className="add-task-button" onClick={() => openAddTaskModal(day.dateKey)}>
                    Add Task
                  </button>
                </div>

                <ul className="task-list">
                  {visibleTasks.length === 0 ? <li className="empty-state">No tasks for this day</li> : null}
                  {visibleTasks.map((task) => {
                    const completed = isTaskCompleted(task, day.dateKey)
                    const indicator = task.type === 'permanent' ? '🔁' : '•'
                    const indicatorTitle = task.type === 'permanent' ? 'Permanent recurring task' : 'Temporary task'

                    return (
                      <li key={`${task.id}-${day.dateKey}`} className={completed ? 'task-item completed' : 'task-item'}>
                        <label className="task-main" title={indicatorTitle}>
                          <span className="task-indicator" title={indicatorTitle}>{indicator}</span>
                          <input
                            type="checkbox"
                            checked={completed}
                            onChange={() => toggleTaskCompletion(task.id, day.dateKey)}
                          />
                          <span>{task.title}</span>
                        </label>
                        <div className="task-actions">
                          <button
                            type="button"
                            className="edit-button"
                            onClick={() => openEditModal(task, day.dateKey)}
                            aria-label={`Edit ${task.title}`}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="delete-button"
                            onClick={() => setDeleteTarget({ task, dateKey: day.dateKey })}
                            aria-label={`Delete ${task.title}`}
                          >
                            🗑
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      </main>

      {isTaskModalOpen ? (
        <div className="modal-backdrop" onClick={closeAddTaskModal}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h2>Add Task</h2>
            <label className="field-label">
              Task Name
              <input
                type="text"
                value={newTaskTitle}
                onChange={(event) => setNewTaskTitle(event.target.value)}
                placeholder="Review Quality Dashboard"
              />
            </label>

            <div className="field-group">
              <span>Add Type</span>
              <div className="toggle-row">
                <label className={newTaskType === 'temporary' ? 'toggle-option active' : 'toggle-option'}>
                  <input
                    type="radio"
                    name="taskType"
                    value="temporary"
                    checked={newTaskType === 'temporary'}
                    onChange={() => setNewTaskType('temporary')}
                  />
                  Temporary
                </label>
                <label className={newTaskType === 'permanent' ? 'toggle-option active' : 'toggle-option'}>
                  <input
                    type="radio"
                    name="taskType"
                    value="permanent"
                    checked={newTaskType === 'permanent'}
                    onChange={() => setNewTaskType('permanent')}
                  />
                  Permanent
                </label>
              </div>
            </div>

            {addTaskError ? <p className="error-message">{addTaskError}</p> : null}

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={closeAddTaskModal}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={handleAddTask}>
                Save Task
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="modal-card delete-modal" onClick={(event) => event.stopPropagation()}>
            <h2>Delete Task</h2>
            <p>
              Are you sure you want to remove <strong>{deleteTarget.task.title}</strong>?
            </p>
            {deleteError ? <p className="error-message">{deleteError}</p> : null}

            {deleteTarget.task.type === 'permanent' ? (
              <div className="modal-actions stacked">
                <button type="button" className="secondary-button" disabled={isDeleting} onClick={() => handleDeleteTask('temporary')}>
                  Delete Temporarily
                </button>
                <button type="button" className="danger-button" disabled={isDeleting} onClick={() => handleDeleteTask('permanent')}>
                  Delete Permanently
                </button>
              </div>
            ) : (
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)}>
                  Cancel
                </button>
                <button type="button" className="danger-button" disabled={isDeleting} onClick={() => handleDeleteTask('temporary')}>
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {editTarget ? (
        <div className="modal-backdrop" onClick={() => setEditTarget(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h2>Edit Task</h2>
            <label className="field-label">
              Task Name
              <input
                type="text"
                value={editedTaskTitle}
                onChange={(event) => setEditedTaskTitle(event.target.value)}
              />
            </label>

            {editTarget.task.type === 'permanent' ? (
              <div className="field-group">
                <span>Edit this task</span>
                <div className="toggle-row">
                  <label className={editMode === 'occurrence' ? 'toggle-option active' : 'toggle-option'}>
                    <input
                      type="radio"
                      name="editMode"
                      value="occurrence"
                      checked={editMode === 'occurrence'}
                      onChange={() => setEditMode('occurrence')}
                    />
                    This Day Only
                  </label>
                  <label className={editMode === 'all' ? 'toggle-option active' : 'toggle-option'}>
                    <input
                      type="radio"
                      name="editMode"
                      value="all"
                      checked={editMode === 'all'}
                      onChange={() => setEditMode('all')}
                    />
                    All Occurrences
                  </label>
                </div>
              </div>
            ) : null}

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setEditTarget(null)}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={handleSaveEdit}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
