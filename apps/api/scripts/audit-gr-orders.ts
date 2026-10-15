import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';

const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'password',
    database: process.env.DB_NAME ?? 'tacksharp',
    connectionLimit: 2,
    allowPublicKeyRetrieval: true,
  }),
});

const numbers = ['GR-KPW25C', 'GR-2PXSHH'];

try {
  await prisma.$connect();

  const orders = await prisma.order.findMany({
    where: {
      organizationId: 'org_gr_chicken',
      orderNumber: { in: numbers },
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      channel: true,
      customerName: true,
      customerPhone: true,
      total: true,
      readyNotice: true,
      readyNoticeAt: true,
      readyNoticeNote: true,
      readyCallId: true,
      createdAt: true,
      updatedAt: true,
      items: {
        select: { name: true, quantity: true, unit: true, menuItemId: true },
      },
      events: {
        orderBy: { createdAt: 'asc' },
        select: { type: true, fromStatus: true, toStatus: true, actor: true, note: true, createdAt: true },
      },
      followUps: {
        orderBy: { createdAt: 'asc' },
        select: {
          kind: true, channel: true, status: true, attempts: true,
          dryRun: true, providerMessageId: true, callId: true,
          lastError: true, result: true, createdAt: true, completedAt: true,
        },
      },
    },
  });

  for (const order of orders) {
    console.log('\n=== ORDER ===');
    console.log(JSON.stringify(order, null, 2));

    const movements = await prisma.inventoryMovement.findMany({
      where: { organizationId: 'org_gr_chicken', orderId: order.id },
      orderBy: { createdAt: 'asc' },
      select: {
        menuItemId: true, delta: true, balanceAfter: true,
        reason: true, dedupeKey: true, createdAt: true,
      },
    });

    console.log('\n=== STOCK MOVEMENTS ===');
    console.log(JSON.stringify(movements, null, 2));
  }

  console.log('\n=== AUDIT SUMMARY ===');
  console.log(`Orders found: ${orders.length} of ${numbers.length}`);
  console.log('No records were created or modified.');
} catch (error) {
  console.error('Audit failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
