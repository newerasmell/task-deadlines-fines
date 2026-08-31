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

  await prisma.fineRule.upsert({
    where: { id: "default-rule" },
    update: {},
    create: {
      id: "default-rule",
      name: "Стандартно правило",
      priority: null,
      baseAmount: 20,
      perDayAmount: 10,
      graceHours: 2,
      maxAmount: 200,
      currency: "BGN",
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
      baseAmount: 50,
      perDayAmount: 25,
      graceHours: 0,
      maxAmount: 500,
      currency: "BGN",
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
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      priority: "MEDIUM",
      status: "PENDING",
    },
  });

  console.log("Seed complete.");
  console.log(`Admin login: ${adminEmail} / ${adminPassword}`);
  console.log(`Employee login: employee@example.com / ChangeMe123!`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
