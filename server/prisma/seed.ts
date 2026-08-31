import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: "Admin",
      role: "ADMIN",
      passwordHash: await hashPassword(adminPassword),
    },
  });

  const employee = await prisma.user.upsert({
    where: { email: "employee@example.com" },
    update: {},
    create: {
      email: "employee@example.com",
      name: "Demo Employee",
      role: "EMPLOYEE",
      passwordHash: await hashPassword("ChangeMe123!"),
    },
  });

  // "Owner" isn't a separate system role — any user (including an admin) can
  // be set as a task's owner/reviewer. This is a demo manager account to show
  // the review flow.
  const manager = await prisma.user.upsert({
    where: { email: "manager@example.com" },
    update: {},
    create: {
      email: "manager@example.com",
      name: "Demo Manager",
      role: "EMPLOYEE",
      passwordHash: await hashPassword("ChangeMe123!"),
    },
  });

  await prisma.fineRule.upsert({
    where: { id: "default-rule" },
    update: {},
    create: {
      id: "default-rule",
      name: "Стандартно правило",
      priority: null,
      baseAmount: 10,
      perDayAmount: 5,
      graceHours: 2,
      maxAmount: 100,
      currency: "EUR",
      active: true,
    },
  });

  await prisma.fineRule.upsert({
    where: { id: "critical-rule" },
    update: {},
    create: {
      id: "critical-rule",
      name: "Критични задачи",
      priority: "CRITICAL",
      baseAmount: 25,
      perDayAmount: 13,
      graceHours: 0,
      maxAmount: 250,
      currency: "EUR",
      active: true,
    },
  });

  await prisma.task.upsert({
    where: { id: "demo-task" },
    update: {},
    create: {
      id: "demo-task",
      title: "Демо задача: изготви месечен отчет",
      description: "Пример за задача със срок, за да видиш как работят напомнянията и глобите.",
      assigneeId: employee.id,
      createdById: admin.id,
      ownerId: manager.id,
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      priority: "MEDIUM",
      status: "PENDING",
    },
  });

  // Demo of a "continuing" (effectively endless) recurring task: social media
  // posting plan due every Tuesday and Wednesday at 17:00, reviewed by the
  // manager. The scheduler creates a fresh occurrence each matching day.
  await prisma.recurringTaskTemplate.upsert({
    where: { id: "demo-recurring-template" },
    update: {},
    create: {
      id: "demo-recurring-template",
      title: "Постинг план за социални мрежи",
      description: "Изготви и публикувай постинг плана за седмицата.",
      assigneeId: employee.id,
      ownerId: manager.id,
      createdById: admin.id,
      priority: "MEDIUM",
      daysOfWeek: "TUE,WED",
      timeOfDay: "17:00",
      active: true,
    },
  });

  console.log("Seed complete.");
  console.log(`Admin login: ${adminEmail} / ${adminPassword}`);
  console.log(`Employee login: employee@example.com / ChangeMe123!`);
  console.log(`Manager (Owner) login: manager@example.com / ChangeMe123!`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
