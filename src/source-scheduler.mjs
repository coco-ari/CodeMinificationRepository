export class SourceScheduler {
  constructor(service, { now = Date.now, tickMs = 1000 } = {}) {
    Object.assign(this, { service, now, tickMs });
    this.next = new Map();
    this.pending = new Map();
  }
  start() { this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref(); }
  tick() {
    const active = new Set();
    for (const project of this.service.store.state.projects) {
      if (!project.enabled || !project.sourceEnabled || !project.syncIntervalSeconds) continue;
      active.add(project.id);
      const interval = project.syncIntervalSeconds * 1000;
      const configuration = `${project.updatedAt}/${interval}`;
      let schedule = this.next.get(project.id);
      if (!schedule || schedule.configuration !== configuration) {
        const offset = parseInt(project.id.slice(0, 8), 16) % Math.min(interval, 10000);
        schedule = { configuration, due: this.now() + offset, failures: 0 };
        this.next.set(project.id, schedule);
      }
      if (this.now() < schedule.due || this.pending.has(project.id) || this.service.inFlight.has(project.id)) continue;
      schedule.due = this.now() + interval;
      const failed = () => {
        schedule.failures = Math.min(schedule.failures + 1, 6);
        schedule.due = this.now() + Math.min(interval * 2 ** schedule.failures, 3600000);
      };
      const task = this.service.sync(project.id).then(() => {
        const current = this.service.store.state.projects.find(p => p.id === project.id);
        if (current?.sourceStatus?.error || current?.status === 'failed') failed();
        else schedule.failures = 0;
      }).catch(failed).finally(() => this.pending.delete(project.id));
      this.pending.set(project.id, task);
    }
    for (const id of this.next.keys()) if (!active.has(id)) this.next.delete(id);
  }
  stop() { clearInterval(this.timer); }
}
