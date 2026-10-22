export const AUTH_PATH = '/communication/ybt/api/iot/client/con'

export function deriveCabinetTargets(state) {
  const auto = Object.values(state.projects).flatMap((project) =>
    project.environments
      .filter((environment) => environment.authBase?.trim())
      .map((environment) => ({
        id: `env:${project.id}:${environment.id}`,
        name: `${project.name}-${environment.name}`,
        url: `${environment.authBase.trim().replace(/\/+$/, '')}${AUTH_PATH}`,
        enabled:
          state.cabinet.targetOverrides?.[`env:${project.id}:${environment.id}`]?.enabled !== false,
        automatic: true,
        projectId: project.id,
        environmentId: environment.id,
      })),
  )
  return [
    ...auto,
    ...(state.cabinet.manualTargets || []).map((target) => ({ ...target, automatic: false })),
  ]
}

export function seedCabinet() {
  const now = Date.now()
  return {
    devices: Array.from({ length: 12 }, (_, index) => {
      const imei = `86000000000${String(index + 1).padStart(4, '0')}`
      const assigned = index < 5
      return {
        id: `cabinet-${index + 1}`,
        imei,
        label:
          ['体验中心 A', '体验中心 B', '东区办公楼', '研发实验室', '样板门店'][index] ||
          `待分配设备 ${index - 4}`,
        targetId: assigned ? 'env:sol:sol-test' : null,
        registeredAt: new Date(now - (index + 1) * 3600000).toISOString(),
        lastAuth: {
          status: assigned ? 'success' : 'unassigned',
          targetId: assigned ? 'env:sol:sol-test' : null,
          at: new Date(now - index * 120000).toISOString(),
          targetUrl: assigned
            ? 'https://sol-test.example.invalid/communication/ybt/api/iot/client/con'
            : null,
          mqttEndpoint: assigned ? 'mqtt.sol-test.example.invalid:1883' : null,
          requestId: `demo-auth-${index + 1}`,
        },
        photo: null,
        revision: 1,
        platform: {
          platformId: index === 4 ? 2 : 8,
          agentId: index === 4 ? null : 1001,
          merchantId: index === 4 ? null : 2001,
          branchId: index === 4 ? null : 3001,
          bindTime: index === 4 ? null : new Date(now - 86400000).toISOString(),
          positions:
            index === 3
              ? []
              : Array.from({ length: 8 }, (_, slot) => ({
                  id: slot + 1,
                  platformId: index === 4 ? 2 : 8,
                })),
        },
      }
    }),
    manualTargets: [
      {
        id: 'manual-lab',
        name: '独立验证平台',
        url: 'https://cabinet-lab.example.invalid/communication/ybt/api/iot/client/con',
        enabled: true,
      },
    ],
    targetOverrides: {},
    settings: {
      enabled: true,
      host: 'cabinet-mysql.example.invalid',
      port: '3306',
      database: 'cabinet_demo',
      username: 'demo_reset',
      password: 'DemoOnly-NotARealSecret',
      tls: true,
      matchIp: '192.0.2.10',
      status: 'connected',
    },
  }
}
