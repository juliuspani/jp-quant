# 05 · Infraestructura y operación 24/7

Fecha de la investigación: **2026-09-30**. Autor: investigación SRE para el proyecto *Inversor JP*.
Stack dado: Node 24 (TypeScript nativo) + ccxt + `node:sqlite` + Telegram + panel HTTP. Máquina: portátil Windows 11 Pro.

> **Copia pública (paso 49).** Los datos de la máquina en que se hizo esta investigación (nombre del equipo, usuario,
> rutas y batería) se han anonimizado o quitado.

Convenciones de este documento:

- **[DOC]** = comprobado en documentación oficial durante esta investigación (URL citada).
- **[LOCAL]** = observado en este portátil con comandos de **solo lectura** (no se cambió ninguna configuración).
- **[3º]** = dato de una fuente de terceros (no oficial); tratar como orientativo.
- **[NV]** = no verificado; ver la sección final "No verificado".
- Ningún comando de este documento se ha ejecutado si modifica el sistema (`powercfg /change`, `schtasks /create`, `reg add`, instalaciones). Están documentados, no aplicados.

---

## 0. Resumen ejecutivo

1. **Supervisión en Windows**: usar el **Programador de tareas** (ya viene con Windows, no hay que instalar nada) con una tarea definida en XML: disparador de arranque + disparador repetido cada 5 minutos como "vigía" + política `IgnoreNew` (si el bot ya corre, el vigía no hace nada; si murió, lo relanza). NSSM lleva sin versión estable desde 2014 y pm2 no tiene arranque nativo en Windows.
2. **Portátil frente a VPS**: el portátil sirve para la fase de simulación (coste 0). Para dinero real conviene un VPS Linux con IPv4 fija (~4-6 €/mes): Binance solo da permiso de trading a claves HMAC que tengan restricción de IP, y una conexión doméstica rara vez tiene IP fija.
3. **Ver el panel desde el móvil**: panel escuchando solo en `127.0.0.1` + **Tailscale Serve** (gratis, sin abrir puertos, sin dominio). Cloudflare Tunnel + Access es la alternativa si se necesita entrar desde dispositivos sin Tailscale, pero exige dominio propio. Abrir puertos en el router: no.
4. **Robustez mínima**: reconciliar con el exchange al arrancar, `clientOrderId` propio persistido antes de enviar, nunca reintentar a ciegas una orden, stop colocado en el exchange, latido externo de "hombre muerto", SQLite en WAL con copias, y comprobar el desfase de reloj.
5. **Tres hallazgos en este portátil que bloquean el 24/7 hoy [LOCAL]**:
   - Cerrar la tapa **suspende** el equipo (acción de tapa = 1 "Suspender", en corriente y en batería).
   - El equipo se suspende tras **180 segundos** de inactividad, también enchufado.
   - El servicio de hora de Windows informa **"sin sincronizar"** (origen: `Local CMOS Clock`, sin última sincronización correcta).

---

## 1. Ejecución 24/7 en un portátil Windows 11

### 1.1 Estado actual observado [LOCAL]

| Comprobación (solo lectura) | Resultado |
|---|---|
| `node --version` | `v24.21.0` en `C:\Program Files\nodejs\node.exe` |
| `powercfg /a` | Disponibles: **Modo de espera S0 (inactivo de baja energía), red conectada** e Hibernar. S1/S2/S3 no disponibles. Es un equipo con *Modern Standby* |
| `powercfg /getactivescheme` | Plan Equilibrado (`381b4222-f694-41f0-9685-ff5bb260df2e`) |
| `powercfg /qh SCHEME_CURRENT SUB_BUTTONS LIDACTION` | Acción al cerrar la tapa: CA = `1` (Suspender), CC = `1` (Suspender). Índices posibles: 0 No hacer nada, 1 Suspender, 2 Hibernar, 3 Apagar |
| `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` | Suspender tras: CA = `0xb4` (180 s), CC = `0xb4` (180 s) |
| `powercfg /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE` | Hibernar tras: CA = `0` (nunca), CC = `0x7fffffff` |
| `w32tm /query /status` | Indicador de salto `3 (sin sincronizar)`, origen `Local CMOS Clock`, última sincronización correcta "sin especificar" |
| Horas activas de Windows Update | Inicio 10, fin 1 (15 horas). Sin directivas de Windows Update configuradas |
| Red | Un único adaptador físico, Wi-Fi. No hay Ethernet |
| Herramientas | `git` y `winget` presentes. No hay Docker, Tailscale, cloudflared, pm2, NSSM ni Servy. `python.exe` es solo el alias de la Microsoft Store |

Nota: el ajuste de tapa está **oculto** en este equipo. `powercfg /query` no lo muestra y `powercfg /aliases` no lista `LIDACTION`; solo aparece con `powercfg /qh`. Por eso abajo se usan los GUID, que son inequívocos.

### 1.2 Evitar suspensión e hibernación (comandos exactos)

Sintaxis de `powercfg` según Microsoft [DOC]: `/change <ajuste> <minutos>`, `/setacvalueindex <esquema> <subgrupo> <ajuste> <índice>`, `/setdcvalueindex`, `/setactive`, `/hibernate off`. Los alias pueden sustituir a los GUID.
Fuente: https://learn.microsoft.com/windows-hardware/design/device-experiences/powercfg-command-line-options

Ejecutar en una terminal **como administrador**:

```bat
:: 1) Nunca suspender ni hibernar estando enchufado (0 = nunca)
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0

:: 2) La pantalla sí puede apagarse (no afecta al bot)
powercfg /change monitor-timeout-ac 5

:: 3) Cerrar la tapa = "No hacer nada" (índice 0), enchufado y en batería
::    Subgrupo SUB_BUTTONS = 4f971e89-eebd-4455-a8de-9e59040e7347
::    Ajuste  LIDACTION   = 5ca83367-6e45-459f-a27b-476b1d01c936
powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0
powercfg /setdcvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0

:: 4) Aplicar los cambios al plan activo
powercfg /setactive SCHEME_CURRENT
```

Opcionales:

```bat
:: Que un corte de luz breve no suspenda el equipo mientras tira de batería
powercfg /change standby-timeout-dc 0

:: Desactivar la hibernación por completo (elimina hiberfil.sys).
:: Contrapartida: sin hibernación, al agotarse la batería el equipo se apaga en seco.
powercfg /hibernate off
```

Verificación (solo lectura):

```bat
powercfg /qh SCHEME_CURRENT SUB_BUTTONS LIDACTION
powercfg /query SCHEME_CURRENT SUB_SLEEP
powercfg /requests
powercfg /sleepstudy /output "%USERPROFILE%\sleepstudy.html"
```

`/requests` enumera qué procesos impiden la suspensión y `/sleepstudy` genera un informe de los últimos tres días de *Modern Standby* [DOC]: sirve para auditar si el equipo se durmió sin que nadie lo notara.

Advertencias propias de un portátil:

- **Modern Standby (S0)**: si el equipo entra en espera (menú Inicio → Suspender, botón de encendido), Windows reduce la actividad de las aplicaciones de escritorio y el bot deja de operar de hecho aunque el proceso siga vivo [NV: comportamiento exacto de throttling]. Hay que evitar la espera del todo, no confiar en que "la red sigue conectada".
- **Calor con la tapa cerrada**: dejar el equipo sobre una superficie dura y ventilada. Si el fabricante ofrece límite de carga (p. ej. 80 %), activarlo: un portátil enchufado 24/7 degrada la batería.
- La batería hace de SAI ante microcortes; el router no tiene esa ventaja, así que un corte de luz suele tumbar la conexión aunque el portátil siga encendido.
- **Defensa en el propio bot**: medir el retraso de un `setInterval` de 1 s. Si un tic llega con más de ~30 s de retraso, el equipo estuvo suspendido o congelado: registrar, alertar por Telegram y **reconciliar con el exchange antes de volver a operar**.

### 1.3 Reinicios por Windows Update

Documentación: https://learn.microsoft.com/windows/deployment/update/waas-restart [DOC]

Hechos verificados:

- Las **horas activas** admiten un rango máximo de **18 horas**; fuera de ellas Windows puede reiniciar solo. Por defecto son 8:00-17:00. Ruta: *Configuración → Windows Update → Opciones avanzadas → Horas activas*.
- Directiva de grupo (Windows 11 Pro tiene `gpedit.msc`): *Configuración del equipo → Plantillas administrativas → Componentes de Windows → Windows Update*.
  - **Configurar Actualizaciones automáticas** con la opción **2 - Notificar para descargar y notificar para instalar**: las actualizaciones no se instalan hasta que el usuario lo decide, así que no hay reinicios sorpresa.
  - **Desactivar el reinicio automático para actualizaciones durante las horas activas**: fija las horas activas por directiva.
  - **No reiniciar automáticamente con usuarios que hayan iniciado sesión…**: solo aplica con la opción 4 y Microsoft avisa de que "no funciona exactamente como se describe" y puede dejar el equipo sin reinicios de calidad indefinidamente. No basar la estrategia en ella.
- Equivalentes de registro documentados (Microsoft desaconseja editar el registro directamente; preferir `gpedit.msc`):
  - `HKLM\Software\Policies\Microsoft\Windows\WindowsUpdate`: `SetActiveHours` (1), `ActiveHoursStart` (0-23), `ActiveHoursEnd` (0-23).
  - `HKLM\Software\Policies\Microsoft\Windows\WindowsUpdate\AU`: `AUOptions` (2 notificar descarga e instalación, 3 descargar y notificar, 4 programar), `NoAutoRebootWithLoggedOnUsers` (1).

Comandos (derivados de esas claves documentadas; no ejecutados [NV]):

```bat
:: Horas activas por directiva: 06:00 a 00:00 (18 h, el máximo)
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate" /v SetActiveHours /t REG_DWORD /d 1 /f
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate" /v ActiveHoursStart /t REG_DWORD /d 6 /f
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate" /v ActiveHoursEnd /t REG_DWORD /d 0 /f

:: Notificar antes de descargar e instalar (sin instalaciones ni reinicios automáticos)
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" /v AUOptions /t REG_DWORD /d 2 /f
```

Recomendación operativa: **no bloquear las actualizaciones para siempre**. Usar la opción 2 y fijar una **ventana de mantenimiento semanal** (p. ej. domingo por la mañana): `/pausa` al bot, instalar actualizaciones, reiniciar, comprobar que la tarea relanza el bot y que la reconciliación sale limpia. La pausa de actualizaciones de la interfaz (1 a 5 semanas) sirve para periodos puntuales [3º].

Qué pasa tras un reinicio de Windows Update: **ARSO** (*Automatic Restart Sign-On*) inicia sesión con el último usuario y bloquea la pantalla. Está activado por defecto en equipos cliente no administrados [DOC]. Aun así, la tarea propuesta abajo no depende de que haya sesión iniciada.
Fuente: https://learn.microsoft.com/windows-server/identity/ad-ds/manage/component-updates/winlogon-automatic-restart-sign-on--arso-

### 1.4 Cortes de wifi

- Este equipo solo tiene Wi-Fi [LOCAL]. La mejora más rentable es un **adaptador USB-C a Ethernet** y cable al router.
- En equipos con Modern Standby la pestaña "Administración de energía" del adaptador puede no existir; el ajuste equivalente está en *Opciones de energía → Configuración del adaptador inalámbrico → Modo de ahorro de energía → Rendimiento máximo* [3º].
- Reservar IP por DHCP en el router para el portátil y, si el router lo permite, fijar canal y banda de 5 GHz.
- Diagnóstico (solo lectura): `netsh wlan show interfaces`.
- Ningún ajuste elimina los cortes. El diseño debe asumirlos: reintentos con backoff, stops en el exchange (sección 4.7) y latido externo (sección 4.6) que avise cuando el bot se queda sin red, porque en ese caso **el propio bot no puede avisar por Telegram**.

### 1.5 Supervisión del proceso: comparación

| Opción | Qué es | A favor | En contra | Veredicto |
|---|---|---|---|---|
| **Programador de tareas** | Componente de Windows | Sin instalación; arranca sin sesión iniciada; XML versionable; disparador repetido + `IgnoreNew` actúa de vigía | No captura stdout/stderr; "reiniciar si falla" tiene semántica poco clara | **Recomendado** |
| **Servy** | Envoltorio de servicios, MIT, mantenido | Servicio real de Windows, rotación de logs, comprobación de salud, `winget install servy` [DOC del proyecto] | Proyecto joven; hay que instalarlo | Alternativa si se quiere un servicio |
| **NSSM** | Envoltorio de servicios clásico | Muy extendido, sintaxis simple | Última versión estable **2.24 (31-08-2014)**; preliminar 2.24-101 de 2017, necesaria en Windows 10 Creators Update o posterior [DOC] | Funciona, pero sin mantenimiento |
| **pm2** | Gestor de procesos Node | Cómodo en Linux | La documentación oficial no ofrece arranque en Windows y remite a `pm2-installer` (tercero); `pm2-windows-service` está archivado y `pm2-windows-startup` lleva ~11 años sin publicar [DOC/3º] | No en Windows |
| Servicio nativo propio | Código de servicio Windows | Control total | Node no implementa el protocolo de servicios; exige un envoltorio igualmente | No |

Fuentes: https://nssm.cc/download · https://nssm.cc/usage · https://github.com/aelassas/servy · https://pm2.keymetrics.io/docs/usage/startup/ · https://github.com/jessety/pm2-installer

### 1.6 Opción recomendada: tarea programada en XML

Elementos del esquema verificados [DOC]:

- `RestartOnFailure` exige `Interval` y `Count` juntos; `Interval` entre `PT1M` y `P31D`.
  https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element
- `ExecutionTimeLimit` = `PT0S` permite ejecución indefinida (el valor por defecto son 3 días, lo que **mataría el bot a las 72 horas**).
  https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-executiontimelimit-settingstype-element
- `MultipleInstancesPolicy` = `IgnoreNew`: no inicia otra instancia si ya hay una en ejecución.
  https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-multipleinstancespolicy-settingstype-element
- `LogonType`: `Password` (se guarda la contraseña; se ejecuta sin sesión iniciada), `S4U` (sin contraseña, pero "sin acceso a la red"), `InteractiveToken` (solo con sesión iniciada).
  https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element

Guardar como `C:\ruta\al\repositorio\ops\bot-task.xml` (archivo a crear; codificación UTF-16 LE, que es la que declara la cabecera):

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Inversor JP: bot de trading. Arranca con el sistema y un vigia lo relanza si no esta en ejecucion.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT1M</Delay>
    </BootTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-10-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId><EQUIPO>\<usuario></UserId>
      <LogonType>Password</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Program Files\nodejs\node.exe</Command>
      <Arguments>--env-file=.env src\main.ts</Arguments>
      <WorkingDirectory>C:\ruta\al\repositorio</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

Registro y operación. Sintaxis de `schtasks /create` verificada [DOC]: `/xml` puede combinarse con `/ru` y `/rp`; si se indica `/ru` sin `/rp`, `schtasks` pide la contraseña por teclado (así no queda escrita en el historial).
Fuente: https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-create

```bat
:: Terminal como administrador
schtasks /create /tn "InversorJP-Bot" /xml "C:\ruta\al\repositorio\ops\bot-task.xml" /ru "<EQUIPO>\<usuario>" /f

:: Lanzar ahora, consultar, detener, borrar
schtasks /run    /tn "InversorJP-Bot"
schtasks /query  /tn "InversorJP-Bot" /v /fo LIST
schtasks /end    /tn "InversorJP-Bot"
schtasks /delete /tn "InversorJP-Bot" /f
```

Por qué está diseñada así:

- **Dos disparadores**. El de arranque cubre reinicios (incluidos los de Windows Update). El repetido cada 5 minutos es el vigía: con `IgnoreNew`, si el bot sigue vivo no ocurre nada; si el proceso murió por cualquier causa, se relanza en 5 minutos como máximo. No depende de cómo interprete Windows "fallo".
- **`LogonType` = `Password`**: el bot arranca sin que nadie inicie sesión y sin ventana. Requiere que la cuenta tenga contraseña. No se usa `SYSTEM` porque daría privilegios máximos a un proceso que carga dependencias de npm y maneja claves de exchange.
- **Baterías**: por defecto el Programador no inicia tareas en batería y las detiene al pasar a batería. Ambos ajustes están desactivados en el XML.
- **Sin límite de tiempo** (`PT0S`).

Detalles a tener en cuenta:

- El Programador **no guarda la salida estándar**. Si el bot no escribe ya su propio log a fichero (incluyendo `uncaughtException` y `unhandledRejection`), usar un envoltorio `ops\run-bot.cmd` como `<Command>` y dejar `<Arguments>` vacío:

  ```bat
  @echo off
  cd /d "C:\ruta\al\repositorio"
  if not exist logs mkdir logs
  "C:\Program Files\nodejs\node.exe" --env-file=.env src\main.ts >> "logs\bot-stdout.log" 2>&1
  exit /b %ERRORLEVEL%
  ```

- El campo `WorkingDirectory` va **sin comillas** aunque la ruta tenga espacios [NV: conocido por experiencia, no localizado en la documentación].
- Windows **no envía una señal de apagado ordenado** a un proceso de consola en segundo plano al detener la tarea o reiniciar: lo termina. El bot debe ser seguro ante un corte en cualquier instante (escrituras transaccionales + reconciliación al arrancar), no depender de un cierre limpio.
- **Instancia única**: además de `IgnoreNew`, el bot debe negarse a arrancar si ya hay otro (p. ej. el `listen()` del panel falla con `EADDRINUSE`, o un fichero de bloqueo con PID). Evita dos bots operando a la vez si alguien ejecuta `npm start` a mano.
- El bot debe **salir con código distinto de 0** ante un error irrecuperable en vez de quedarse colgado; de un proceso colgado solo avisa el latido externo (4.6).

### 1.7 Alternativas como servicio (referencia)

Servy (opciones de `servy-cli install` documentadas en su wiki [DOC del proyecto]; comando no ejecutado):

```powershell
winget install servy
servy-cli install `
  --name="InversorJP" `
  --path="C:\Program Files\nodejs\node.exe" `
  --startupDir="C:\ruta\al\repositorio" `
  --params="--env-file=.env src\main.ts" `
  --startupType=Automatic `
  --stdout="C:\ruta\al\repositorio\logs\out.log" `
  --stderr="C:\ruta\al\repositorio\logs\err.log" `
  --enableHealth --recoveryAction=RestartProcess
```

NSSM (sintaxis de https://nssm.cc/usage [DOC]; usar la compilación 2.24-101):

```bat
nssm install InversorJP "C:\Program Files\nodejs\node.exe" --env-file=.env src\main.ts
nssm set InversorJP AppDirectory "C:\ruta\al\repositorio"
nssm set InversorJP AppStdout "C:\ruta\al\repositorio\logs\out.log"
nssm set InversorJP AppStderr "C:\ruta\al\repositorio\logs\err.log"
nssm set InversorJP AppRotateFiles 1
nssm set InversorJP AppExit Default Restart
nssm set InversorJP AppRestartDelay 5000
nssm set InversorJP Start SERVICE_AUTO_START
nssm start InversorJP
```

---

## 2. Alternativa VPS / nube

### 2.1 Precios actuales (septiembre de 2026)

| Proveedor / plan | Recursos | Precio | IPv4 fija | Notas | Fuente |
|---|---|---|---|---|---|
| **Hetzner Cloud CX23** | 2 vCPU, 4 GB, 40 GB | **5,49 €/mes** sin IVA (antes 3,99 €; subida del 15-06-2026) | +0,50 €/mes [3º] → ~5,99 € | Solo Alemania/Finlandia. Disponibilidad intermitente: el 21-09-2026 figuraba como "no disponible" con reposiciones irregulares [3º] | https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ · https://costgoat.com/pricing/hetzner · https://www.cloudhim.com/cloud-costs/hetzner-cx22-pricing-2026 |
| Hetzner CAX11 (ARM) | 2 vCPU, 4 GB, 40 GB | 5,99 €/mes sin IVA (antes 4,49 €) | +0,50 €/mes [3º] | ARM; mismas reservas de disponibilidad | Ídem |
| Hetzner CX33 | 4 vCPU, 8 GB, 80 GB | 8,49 €/mes sin IVA | +0,50 €/mes [3º] | | Ídem |
| **OVHcloud VPS-1** | 2 vCores, 4 GB, 40 GB NVMe | **desde 3,81 €/mes sin IVA (4,61 € con IVA)** | Incluida | Copia diaria incluida. El precio "desde" va ligado a compromiso (la web de EE. UU. indica 12 meses por adelantado) | https://www.ovhcloud.com/es-es/vps/ · https://www.ovhcloud.com/en/vps/ |
| OVHcloud VPS-2 | 4 vCores, 8 GB, 75 GB | desde 7,21 €/mes sin IVA (8,72 € con IVA) | Incluida | | Ídem |
| **Contabo Cloud VPS 4** | 4 vCPU, 8 GB, 100 GB SSD | Orden de 4,40-5,50 €/mes con compromiso de 24 meses; ~6,31 USD/mes según un comparador [NV] | Incluida | La página oficial no dejó claro el precio a 1 mes. Fama de CPU sobrevendida | https://contabo.com/en/vps/ · https://vpsarena.app/providers/contabo |
| **Oracle Cloud Always Free** | 2 VM AMD micro + Ampere A1 hasta **2 OCPU / 12 GB** | 0 € | Sí | Oracle redujo A1 de 4 OCPU/24 GB a la mitad el 15-06-2026 **sin anuncio**; puede **reclamar instancias inactivas** (CPU, red y memoria < 20 % durante 7 días) | https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm · https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/ |
| **Fly.io** | Máquina compartida pequeña | Tarifas base: 0,00000075 USD por vCPU compartida y segundo, 0,00000193 USD por GB de RAM y segundo; volumen 0,15 USD/GB-mes. Total mensual exacto [NV] | IP de salida estática: 0,005 USD/h (~3,60 USD/mes). IPv4 dedicada de entrada: 2 USD/mes | Sin nivel gratuito: prueba de 2 h de máquina o 7 días | https://docs.fly.io/about/pricing/ · https://docs.fly.io/about/free-trial/ |
| **Railway** | Por uso | Hobby 5 USD/mes (incluye 5 USD de uso); Pro 20 USD/mes. RAM 10 USD/GB-mes, CPU 20 USD/vCPU-mes, volumen 0,15 USD/GB-mes | IP de salida estática **solo en Pro**, tres IP y no garantizadas como dedicadas | Pensado para servicios web, no para un proceso con disco local | https://railway.com/pricing · https://docs.railway.com/networking/static-outbound-ips |

Lectura:

- Para un bot de un solo proceso con SQLite en disco local, lo adecuado es un **VPS clásico** (Hetzner, OVH, Contabo). Un PaaS (Fly, Railway) complica la IP de salida fija y el disco persistente, y acaba costando más.
- **Oracle Free** no es apto para dinero real: un bot consume muy poca CPU, que es justo el perfil que Oracle marca como "inactivo" y reclama, y el recorte silencioso de junio de 2026 muestra que las condiciones cambian sin aviso.
- 1 vCPU y 1-2 GB de RAM bastan para este bot; los planes de la tabla son los más pequeños que venden hoy esos proveedores.

### 2.2 La IP fija y la lista blanca de la clave API

- Binance [DOC]: las claves HMAC **sin restricción de IP no tienen más permiso que lectura**. Para habilitar el trading hay que añadir restricción de IP (IPv4), usar claves autogeneradas (Ed25519 o RSA) o desactivar los controles de seguridad por defecto. El permiso de retirada exige restricción de IP siempre.
  Fuente: https://www.binance.com/en/support/faq/detail/360002502072
- Una conexión doméstica suele tener IP dinámica o CG-NAT: la lista blanca se rompe cuando cambia la IP y el bot se queda sin poder operar (ni cerrar posiciones). Un VPS con IPv4 dedicada lo resuelve de raíz.
- Con la IP en lista blanca, una clave robada no sirve desde otra máquina. Es la medida de seguridad con mejor relación coste/beneficio.
- Los límites de peticiones de Binance son **por IP, no por clave** [DOC]: una IP dedicada evita compartir cuota con nadie.
- Elegir un centro de datos en la UE: algunos exchanges restringen por país de la IP [NV].

### 2.3 Cuándo merece la pena migrar

Migrar al VPS cuando se cumpla cualquiera de estas condiciones:

1. Se va a operar con **dinero real** (la principal).
2. La clave API exige lista blanca de IP y en casa no hay IP fija.
3. Hay más de un incidente al mes por wifi, suspensión, Windows Update o cortes de luz.
4. El portátil se necesita para otra cosa o sale de casa.
5. El capital en juego hace que ~5 €/mes sea irrelevante frente a una sola operación mal gestionada.

Quedarse en el portátil mientras el bot esté en **modo simulado**: cuesta 0 € y una caída solo pierde datos de prueba.

En el VPS (Linux) la supervisión es una unidad `systemd` estándar (no ejecutada [NV]):

```ini
# /etc/systemd/system/inversor-jp.service
[Unit]
Description=Inversor JP bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bot
WorkingDirectory=/opt/inversor-jp
ExecStart=/usr/bin/node --env-file=.env src/main.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/inversor-jp/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now inversor-jp
journalctl -u inversor-jp -f
```

---

## 3. Monitorización desde el móvil

### 3.1 Bot de Telegram

Crear el bot [DOC]: hablar con **@BotFather**, enviar `/newbot`, elegir nombre y un usuario de 5 a 32 caracteres que termine en `bot`. BotFather devuelve un token con forma `110201543:AAH…`. Quien tenga el token controla el bot; si se filtra, `/token` en BotFather genera otro. `/setcommands` define la lista de comandos sugeridos.
Fuente: https://core.telegram.org/bots/features

API [DOC] (Bot API 10.3, 24-08-2026): https://core.telegram.org/bots/api

- Formato: `https://api.telegram.org/bot<token>/NOMBRE_METODO`, siempre HTTPS.
- `sendMessage`: obligatorios `chat_id` y `text` (1 a 4096 caracteres). Opcionales `parse_mode`, `disable_notification`, `link_preview_options`.
- `getUpdates`: `offset`, `limit` (1-100), `timeout` en segundos (0 = sondeo corto; >0 = *long polling*), `allowed_updates`. Una actualización queda confirmada cuando se llama con un `offset` mayor que su `update_id`. Un `offset` negativo recupera desde el final de la cola. Telegram conserva las actualizaciones hasta 24 horas. **No funciona si hay un webhook configurado.**
- Límites [DOC, https://core.telegram.org/bots/faq]: no más de ~1 mensaje por segundo en un mismo chat (ráfagas cortas toleradas; luego error 429), 20 mensajes por minuto en un grupo, ~30 mensajes por segundo en total.

Por qué *long polling* y no webhook: el webhook exige una URL HTTPS pública entrante, que es justo lo que se quiere evitar. `getUpdates` solo hace conexiones salientes.

Pruebas manuales (en PowerShell usar `curl.exe`; `curl` a secas es un alias de `Invoke-WebRequest`):

```bat
curl.exe "https://api.telegram.org/bot<TOKEN>/getMe"
curl.exe "https://api.telegram.org/bot<TOKEN>/getUpdates?timeout=30"
curl.exe -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" -d chat_id=<CHAT_ID> -d text="hola"
```

Obtener el `chat_id`: enviar `/start` al bot desde el móvil y leer `result[0].message.chat.id` en la respuesta de `getUpdates`. Un bot no puede escribir a un usuario que no le haya hablado antes [NV: regla conocida, no localizada en la página consultada].

Esqueleto del bucle de comandos (TypeScript compatible con el borrado de tipos de Node; sin dependencias):

```ts
const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const AUTORIZADO = Number(process.env.TELEGRAM_CHAT_ID);
const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(metodo: string, cuerpo: object, esperaMs = 15_000): Promise<any> {
  const res = await fetch(`${API}/${metodo}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(esperaMs),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${metodo}: ${json.error_code} ${json.description}`);
  return json.result;
}

export async function bucleComandos(manejar: (cmd: string) => Promise<string>): Promise<void> {
  // Descartar el atraso: no ejecutar un /reanudar enviado hace horas mientras el bot estaba caído.
  let offset = 0;
  const atraso = await tg('getUpdates', { offset: -1, timeout: 0 });
  if (atraso.length > 0) offset = atraso[atraso.length - 1].update_id + 1;

  for (;;) {
    try {
      // La espera HTTP (60 s) debe superar el timeout del long polling (50 s).
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 60_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text) continue;
        // Único chat autorizado, y además privado (en un chat privado chat.id === from.id).
        if (m.chat.id !== AUTORIZADO || m.from?.id !== AUTORIZADO) continue; // silencio total
        const cmd = m.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
        const respuesta = await manejar(cmd);
        await tg('sendMessage', { chat_id: AUTORIZADO, text: respuesta.slice(0, 4096) });
      }
    } catch {
      // No registrar la URL ni el error en bruto: la URL contiene el token.
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
```

Reglas de seguridad del canal:

- **Un único `chat_id` autorizado**, leído de `.env`. A cualquier otro remitente **no se le responde nada** (responder confirma que el bot existe y acepta órdenes).
- No añadir el bot a grupos. Con el modo privacidad por defecto un bot en un grupo solo ve comandos, pero cualquier miembro podría enviarlos.
- Comandos **acotados**: `/estado`, `/posiciones`, `/pausa` (no abrir posiciones nuevas; los stops siguen activos), `/reanudar`. Un eventual `/cerrar_todo` debe pedir confirmación en dos pasos con caducidad.
- Por Telegram **nunca** se cambia configuración, claves ni límites de riesgo, y nunca se muestran secretos.
- `/pausa` y `/reanudar` deben **persistir en SQLite**: tras un reinicio el bot arranca en el estado en que estaba.
- Descartar el atraso al arrancar (ya incluido en el esqueleto).
- Respetar 1 mensaje por segundo: agrupar avisos y aplicar antirrebote a los errores repetidos.
- Referencia de diseño: Freqtrade restringe por `chat_id` y `authorized_users`, y ofrece `/status`, `/profit`, `/balance`, `/pause` o `/stopentry`, `/forceexit`, `/reload_config`. https://www.freqtrade.io/en/stable/telegram-usage/

### 3.2 Exponer el panel web de forma segura

| Vía | Cómo funciona | Coste | Requisitos | Riesgo | Veredicto |
|---|---|---|---|---|---|
| **Tailscale Serve** | Red privada WireGuard; el panel solo es alcanzable desde dispositivos de la propia tailnet, con HTTPS automático | Plan Personal gratuito: hasta 6 usuarios y dispositivos ilimitados [DOC] | App de Tailscale en portátil y móvil | Mínimo: no existe URL pública | **Recomendado** |
| Cloudflare Tunnel + Access | `cloudflared` abre una conexión **saliente**; Cloudflare publica un nombre de host y Access exige identificarse antes de llegar al panel | Tunnel gratuito; Access gratuito hasta 50 usuarios [3º] | **Dominio propio dado de alta en Cloudflare** [DOC]. En Windows `cloudflared` **no se actualiza solo** [DOC] | Medio: hay un nombre público y la protección depende de no equivocarse en la política de Access | Alternativa |
| Tailscale Funnel | Publica el servicio en Internet | Gratis | | Alto para un panel de trading | No |
| Abrir puertos en el router | Reenvío de puertos hacia el portátil | Gratis | IP pública, DDNS | Alto: panel expuesto a escaneo continuo, sin TLS ni autenticación fuertes por defecto, inviable tras CG-NAT | **Desaconsejado** |

Fuentes: https://tailscale.com/pricing · https://tailscale.com/docs/features/tailscale-serve · https://tailscale.com/docs/reference/tailscale-cli/serve · https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/ · https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/ · https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Pasos con Tailscale (comandos de la documentación oficial; no ejecutados):

1. Instalar Tailscale en el portátil (instalador `.exe` o `.msi` de https://tailscale.com/download/windows; requiere Windows 10 o posterior) y en el móvil; iniciar sesión con la misma cuenta.
2. Que Tailscale siga conectado sin sesión iniciada en Windows:

   ```bat
   tailscale set --unattended=true
   ```

   Fuente: https://tailscale.com/docs/how-to/run-unattended
3. El panel debe escuchar **solo** en `127.0.0.1` (p. ej. puerto 8787), nunca en `0.0.0.0`.
4. Publicarlo dentro de la tailnet (Serve pide habilitar certificados HTTPS la primera vez):

   ```bat
   tailscale serve --bg 8787
   tailscale serve status
   :: Para retirarlo:
   tailscale serve reset
   ```

   `--bg` lo deja en segundo plano y persiste entre reinicios [DOC].
5. Desde el móvil, con Tailscale activo: `https://<nombre-equipo>.<tailnet>.ts.net`.

Defensa en profundidad, con cualquier vía:

- El panel es de **solo lectura** por defecto. Las acciones (pausar) exigen un token propio del panel, distinto de cualquier otra credencial.
- Serve añade la cabecera `Tailscale-User-Login` con la identidad del visitante [DOC]; el panel puede comprobar que coincide con el correo esperado. Solo es fiable si el panel escucha en `127.0.0.1`.
- El panel nunca muestra claves ni el contenido de `.env`.

Con Cloudflare (si se elige): crear el túnel en el panel de Cloudflare (*Networking → Tunnels → Create a tunnel*), ejecutar en el portátil el comando de instalación que muestra el propio panel, publicar `http://localhost:8787` como aplicación y **crear la política de Access antes de publicar**. `cloudflared` se instala como servicio con `cloudflared.exe service install` y se gestiona con `sc start cloudflared` / `sc stop cloudflared` [DOC].
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/windows/

---

## 4. Robustez del bot

El proyecto usa hoy `binance` como exchange por defecto (spot, sin apalancamiento) [LOCAL, `src/config.ts`], así que los ejemplos concretos son de la API Spot de Binance.

### 4.1 Reconciliación al arrancar

Principio: **el exchange es la fuente de verdad; SQLite es una caché con intenciones**. En cada arranque, y tras detectar una suspensión o un corte largo, antes de permitir ninguna orden nueva:

1. Cargar de SQLite las órdenes no terminales y las posiciones abiertas.
2. Pedir al exchange: saldos (`fetchBalance`), órdenes abiertas (`fetchOpenOrders`) y operaciones recientes (`fetchMyTrades`) desde la última marca guardada.
3. Para cada orden local no terminal, consultarla por su `clientOrderId` y actualizar estado, cantidad ejecutada, precio medio y comisiones.
4. Para cada orden abierta en el exchange que no exista en local: **no adoptarla ni tocarla** y avisar. Si lleva el prefijo del bot (orden huérfana), avisar a una persona y bloquear las órdenes nuevas en ese símbolo hasta que lo resuelva: como toda orden se guarda antes de enviarse, una huérfana indica una base de datos perdida o restaurada. *(Actualizado en el paso 7: antes proponía adoptarlas. Ver ADR 0005 y `.claude/skills/exchange-execution/SKILL.md` §14.)*
5. Comparar la posición calculada con el saldo real. Si la diferencia supera una tolerancia: seguir en **modo UNKNOWN** (sin órdenes nuevas) y alertar, no "corregir" automáticamente.
6. Comprobar que cada posición abierta tiene su stop vivo en el exchange. Si falta, y los pasos anteriores han cuadrado órdenes y saldos, colocarlo como única excepción del modo UNKNOWN: orden `reduce_only` aprobada por el Risk Engine.
7. Solo entonces salir del modo UNKNOWN y habilitar entradas.

Una orden "pendiente de envío" o enviada sin respuesta y sin rastro en el exchange solo se marca como no enviada cuando han pasado `recvWindow` + 5 s desde la firma de la petición y 2 consultas seguidas por su `clientOrderId` dicen que no existe. **No se reenvía automáticamente**: que decida la estrategia en el siguiente ciclo, con una aprobación nueva.

*(Pasos 5 y 6 y párrafo anterior actualizados en el paso 7C para coincidir con ADR 0005 y `.claude/skills/exchange-execution/SKILL.md` §3, §9.2 y §14.)*

Freqtrade sigue el mismo orden en cada iteración: carga las operaciones abiertas de la persistencia, actualiza el estado de las órdenes desde el exchange, gestiona tiempos de espera, procesa salidas y solo al final las entradas.
https://www.freqtrade.io/en/stable/bot-basics/

### 4.2 Idempotencia con `clientOrderId`

- Generar un identificador propio por **aprobación del Risk Engine**: `ijp-` más el `approval_id` en base64url. Una intención que se vuelve a intentar recibe una aprobación y un identificador nuevos. Guardarlo en SQLite en estado `PENDING_SEND` **en una transacción confirmada antes de llamar al exchange**, y enviarlo como `clientOrderId` (ccxt lo admite en `params` de `createOrder` en los exchanges que lo soportan [DOC, manual de ccxt]). *(Actualizado en el paso 7C: antes decía «por intención». El código actual usa el prefijo `jp-` por intento; ver `.claude/skills/exchange-execution/SKILL.md` §5 y §18.)*
- Binance [DOC]: `newClientOrderId` es "un identificador único entre las órdenes abiertas"; una orden con el mismo identificador solo se acepta cuando la anterior ya se ha ejecutado. Consecuencia: **el exchange no deduplica una orden a mercado ya ejecutada**. La deduplicación es responsabilidad del bot.
  https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints
- Regla de oro tras un tiempo de espera agotado en `createOrder` [DOC, manual de ccxt]: **asumir que la orden pudo haberse colocado** y verificar con `fetchOrder` / `fetchOpenOrders` antes de reintentar. En Binance se puede consultar por `origClientOrderId`.
- Nunca reutilizar un `clientOrderId` para una intención distinta.

### 4.3 Ejecuciones parciales

- Tratar `filled`, `remaining`, `average` y `fee` de la estructura de orden de ccxt como datos que cambian. La posición es la **suma de ejecuciones**, no la cantidad pedida.
- Estados a contemplar: abierta, parcialmente ejecutada, cerrada, cancelada con ejecución parcial, caducada (`EXPIRED` en Binance).
- **Comisión en el activo base**: si la comisión de una compra se cobra en la moneda comprada, el saldo disponible es menor que `filled`. El stop y la venta posteriores deben usar la cantidad **realmente disponible**, redondeada a la precisión del mercado. Es un fallo clásico (venta rechazada por saldo insuficiente).
- Restos por debajo del mínimo del mercado ("polvo"): registrarlos y excluirlos de la lógica de posición.
- Las órdenes límite necesitan tiempo de vida: al vencer, cancelar y registrar la parte ejecutada.

### 4.4 Reintentos con backoff exponencial

- Reintentar **solo** lecturas y operaciones idempotentes. Según el manual de ccxt son recuperables `RequestTimeout`, `ExchangeNotAvailable`, `DDoSProtection`, `RateLimitExceeded` e `InvalidNonce` (este último pide resincronizar la hora antes). No reintentar `InsufficientFunds`, `InvalidOrder` ni `AuthenticationError`: son errores de lógica o de credenciales.
  https://docs.ccxt.com/docs/manual
- Espera = `min(tope, base × 2^intento)` con **jitter** aleatorio. Valores razonables: base 1 s, tope 60 s.
- **Cortacircuitos**: tras N fallos consecutivos, pausar las entradas y alertar. Las salidas y el mantenimiento de stops se vuelven a proponer en cada ciclo, cada vez con una aprobación y un identificador nuevos; **nunca se reenvía a ciegas la misma orden**. *(Actualizado en el paso 7C; ver ADR 0005.)*
- Tiempo de espera explícito en cada petición (`timeout` de ccxt); ninguna llamada debe poder colgar el bucle.

### 4.5 Límites de peticiones y reloj

Límites (Binance [DOC], https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits):

- Cada respuesta trae `X-MBX-USED-WEIGHT-*` con el peso consumido por la IP.
- HTTP **429** = límite superado: hay que dejar de insistir. Insistir lleva a HTTP **418** = IP vetada, de 2 minutos a 3 días. Ambos incluyen `Retry-After` en segundos: respetarlo.
- Los límites son **por IP**, no por clave.
- ccxt trae `enableRateLimit` activado por defecto [DOC]. No desactivarlo y no lanzar peticiones en paralelo sin control.

Reloj (Binance [DOC], https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security):

- Las peticiones firmadas llevan `timestamp`; `recvWindow` vale 5000 ms por defecto y 60000 como máximo. Binance recomienda 5000 o menos. Fuera de ventana, error `-1021`.
- **No subir `recvWindow` para tapar un reloj mal sincronizado**: arreglar el reloj.
- En este portátil el servicio de hora informa "sin sincronizar" [LOCAL]. Además, en equipos fuera de dominio el servidor por defecto es `time.windows.com` y el intervalo de sondeo queda acotado entre 2^10 y 2^15 segundos (~17 minutos a ~9 horas) [DOC].
  https://learn.microsoft.com/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings

Comandos de `w32tm` (sintaxis de la documentación de Microsoft; los que modifican no se han ejecutado):

```bat
:: Diagnóstico (solo lectura)
w32tm /query /status
w32tm /stripchart /computer:time.windows.com /samples:5 /dataonly

:: Corrección (terminal como administrador)
w32tm /config /manualpeerlist:"time.windows.com pool.ntp.org" /syncfromflags:manual /update
w32tm /resync /rediscover
```

Si el servicio no arranca solo con el sistema: `Set-Service w32time -StartupType Automatic; Start-Service w32time` [NV].

Defensa en el bot, independiente de Windows:

- Al arrancar y cada hora, comparar `Date.now()` con la hora del servidor del exchange (`fetchTime`). Si el desfase supera ~1000 ms: alertar y pausar entradas.
- ccxt ofrece la opción `adjustForTimeDifference` para compensar el desfase [DOC]. Es una red de seguridad, no un sustituto de NTP.
- Freqtrade añadió en su versión 2026.9 (29-09-2026) una comprobación de desfase contra el reloj del exchange y exige en su documentación mantener el reloj sincronizado por NTP.
  https://github.com/freqtrade/freqtrade/releases/latest

### 4.6 Latido y alerta de "hombre muerto"

El problema: si el bot, el portátil o la red caen, **el bot no puede avisar de su propia muerte**. Hace falta un vigilante externo que avise cuando *deja de recibir* señales.

healthchecks.io [DOC]:

- URL de ping: `https://hc-ping.com/<uuid>`. Se pueden añadir `/start`, `/fail` o un código de salida.
- Cada comprobación tiene **periodo** y **tiempo de gracia**. Si el ping no llega a tiempo pasa a "Down" y se envían las alertas.
- Plan gratuito **Hobbyist**: **20 comprobaciones**, 100 entradas de registro por comprobación. Sin créditos de SMS, WhatsApp ni llamada (eso empieza en Business, 20 USD/mes: 100 comprobaciones, 50 SMS/WhatsApp, 20 llamadas). "Supporter" (5 USD/mes) tiene los mismos límites que el gratuito.
- Integración con Telegram mediante `HealthchecksBot` (enviarle `/start` y confirmar el enlace); también correo.
- Fuentes: https://healthchecks.io/pricing/ · https://healthchecks.io/docs/ · https://healthchecks.io/integrations/telegram/

Cómo usarlo bien:

```ts
// Al final de cada ciclo COMPLETO y correcto del bucle de trading (no en un temporizador aparte):
await fetch(`https://hc-ping.com/${process.env.HC_PING_UUID}`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
```

- El ping sale **del mismo bucle que opera**, después de haber hablado con el exchange. Un temporizador independiente seguiría latiendo con el bucle principal colgado.
- Periodo 1-5 minutos y gracia de 5 minutos: aviso en ~10 minutos sin falsas alarmas por un microcorte.
- Configurar **dos canales** (Telegram y correo).
- Dos comprobaciones bastan: "bucle de trading" y "copia de seguridad diaria". Sobra plan gratuito.
- La URL de ping es un secreto menor: va en `.env` y no se registra.
- Latido interno complementario: guardar en SQLite la hora del último ciclo y mostrar en el panel "último ciclo hace N s", en rojo si supera el umbral.

Interruptor de hombre muerto **en el exchange**, cuando existe: Kraken ofrece `CancelAllOrdersAfter`, que cancela todas las órdenes si el cliente no renueva el temporizador (recomiendan llamar cada 15-30 s con un tiempo de 60 s) [DOC]. Atención: **cancela también los stops de protección**, así que encaja con órdenes de entrada pendientes, no con stops.
https://docs.kraken.com/api/docs/rest-api/cancel-all-orders-after

### 4.7 Caída de la API del exchange con posiciones abiertas

| | Stop gestionado solo por el bot | Stop colocado en el exchange |
|---|---|---|
| Bot caído, portátil suspendido o sin red | **Sin protección** | Protegido |
| API REST del exchange caída, motor de emparejamiento vivo | Sin protección (no se puede enviar la venta) | Protegido: se ejecuta dentro del exchange |
| Exchange totalmente caído | Sin protección | Sin protección |
| Latencia en un desplome | Depende de red y ciclo del bot | Sin salto de red |
| Coste | Ninguno | En spot, la orden de stop **bloquea el saldo** |

Conclusión: **todo stop de protección vive en el exchange** desde el momento en que la entrada se ejecuta. El bot lo supervisa y lo mueve; no lo sustituye.

Detalles para spot en Binance [DOC, tipos de orden]:

- Tipos: `STOP_LOSS`, `STOP_LOSS_LIMIT`, `TAKE_PROFIT`, `TAKE_PROFIT_LIMIT`, con `stopPrice`. Las listas **OCO** emparejan dos órdenes: al activarse una se cancela la otra, lo que permite tener stop y objetivo a la vez sobre el mismo saldo.
- Un stop **límite** puede no ejecutarse si el precio atraviesa el límite de golpe: dejar holgura entre precio de disparo y precio límite.
- La cantidad del stop debe ser la **realmente ejecutada y disponible** (4.3).
- Qué tipos admite cada mercado depende del símbolo: consultarlo al arrancar, no suponerlo [NV para cada par concreto].

Diseño de referencia: `stoploss_on_exchange` de Freqtrade. Coloca el stop en el exchange tras la entrada, lo revisa como mucho cada 60 s (`stoploss_on_exchange_interval`, para no ser vetado por exceso de peticiones) y, si no consigue colocarlo, ejecuta una **salida de emergencia** a mercado (`emergency_exit`).
https://www.freqtrade.io/en/stable/stoploss/

Procedimiento durante una caída de la API:

1. Dejar de abrir posiciones (cortacircuitos).
2. Seguir intentando **solo lecturas** con backoff largo; respetar `Retry-After`.
3. Alertar por Telegram una vez, no en cada reintento.
4. No cancelar ni recolocar stops a ciegas.
5. Al volver la API: reconciliación completa (4.1) antes de reanudar.
6. Tener anotado el plan manual: iniciar sesión en la web o app del exchange y cerrar a mano.

### 4.8 SQLite: WAL y copias de seguridad

Hechos [DOC]: https://www.sqlite.org/wal.html · https://www.sqlite.org/lang_vacuum.html · https://www.sqlite.org/howtocorrupt.html

- `PRAGMA journal_mode=WAL;` es **persistente**. Los lectores no bloquean al escritor ni al revés: el panel puede leer mientras el bot escribe.
- Crea los ficheros `-wal` y `-shm`, que deben permanecer junto a la base de datos. Separarlos puede perder transacciones o corromperla.
- WAL **no funciona sobre sistemas de archivos de red**.
- Punto de control automático a las ~1000 páginas; manual con `PRAGMA wal_checkpoint(TRUNCATE);`.
- Con `synchronous=NORMAL` en WAL las últimas transacciones pueden **no ser duraderas** ante un corte de luz (la base no se corrompe, pero se pierde lo último). Para un libro de órdenes con pocas escrituras compensa `synchronous=FULL`.
- **Copiar el fichero `.db` mientras hay transacciones activas puede producir una copia corrupta.** Métodos seguros: `VACUUM INTO 'ruta'` (instantánea coherente; el destino no debe existir) o la API de copia.
- La documentación menciona un fallo de reinicio de WAL corregido en SQLite 3.51.3. El SQLite empaquetado en el Node de este equipo es **3.53.4** [LOCAL], posterior a la corrección.

Configuración inicial con `node:sqlite`:

```ts
import { DatabaseSync, backup } from 'node:sqlite';

const db = new DatabaseSync('data/bot.db', { timeout: 5000 }); // espera ante bloqueo, en ms
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = FULL');
// Las claves foráneas ya están activadas por defecto (enableForeignKeyConstraints: true).
```

Copias (la función `backup()` existe desde Node v23.8.0 y devuelve una promesa [DOC]):

```ts
const destino = `backups/bot-${new Date().toISOString().slice(0, 10)}.db`;
await backup(db, destino);
// Alternativa en SQL (el fichero de destino no debe existir):
// db.exec(`VACUUM INTO '${destino}'`);
```

Prácticas:

- Copia **diaria** y antes de cada actualización del bot; conservar 14 diarias y 8 semanales.
- Llevar las copias **fuera del portátil** (otro disco o nube, cifradas). Una copia en el mismo disco no protege de robo ni de fallo de disco.
- **No** poner `data/` dentro de una carpeta sincronizada (OneDrive, Dropbox): el sincronizador copia el `.db` sin su `-wal` [NV: recomendación general; la página de SQLite no menciona la sincronización en la nube de forma expresa].
- Verificar las copias: abrirlas y ejecutar `PRAGMA integrity_check;`. Ensayar una restauración completa al menos una vez.
- Cada cambio de estado de una orden o posición va en **una sola transacción**.
- Registro de solo inserción para órdenes, ejecuciones y eventos: no actualizar en sitio lo que servirá para auditoría y fiscalidad.
- `node:sqlite` es **síncrono**: cada consulta bloquea el bucle de eventos. Con pocas escrituras pequeñas es irrelevante; no hacer consultas pesadas del panel en el mismo proceso sin paginar.

---

## 5. Seguridad de secretos

### 5.1 `.env` fuera de git

- El `.gitignore` del proyecto ya excluye `.env`, `data/`, `*.log` y `node_modules/` [LOCAL]. Comprobar siempre con `git status` antes del primer commit y tras mover ficheros.
- Node carga el fichero sin dependencias: `node --env-file=.env src/main.ts`. La opción es **estable desde v24.10.0**; si una variable ya existe en el entorno, prevalece la del entorno; si el fichero no existe, error (`--env-file-if-exists` lo tolera) [DOC].
  https://nodejs.org/docs/latest-v24.x/api/cli.html
- Mantener un `.env.example` con los nombres y sin valores.
- Restringir el acceso al fichero a la cuenta que ejecuta el bot (permisos NTFS).
- Cifrado de disco (BitLocker o cifrado de dispositivo): un portátil se puede perder o robar, y `.env` está en claro.
- Las copias de seguridad **no incluyen `.env`**; las claves se guardan aparte, en un gestor de contraseñas.

### 5.2 Claves API

- Permisos: **lectura + trading spot**. **Retirada desactivada siempre.** Sin márgenes, futuros ni transferencias.
- **Lista blanca de IP** (2.2). En Binance es condición para que una clave HMAC pueda operar.
- Preferir claves **Ed25519** autogeneradas: la clave privada no sale del equipo, y Binance las recomienda por rendimiento y seguridad [DOC]. Compatibilidad con ccxt [NV].
- Una clave por entorno (simulación / real) y por bot. Nunca reutilizar la clave de otra herramienta.
- Si el exchange lo permite, operar desde una **subcuenta** con solo el capital asignado al bot: acota la pérdida máxima ante un fallo de software.
- En la cuenta: segundo factor (passkey o TOTP, no SMS), código antiphishing y lista blanca de direcciones de retirada.

### 5.3 Qué no registrar nunca en los logs

- Clave API, secreto o contraseña de API; firmas (`signature`) y cadenas de consulta firmadas.
- Cabeceras de petición completas (`X-MBX-APIKEY`).
- La salida de `verbose: true` de ccxt, que vuelca peticiones con cabeceras [NV].
- El **token de Telegram**, que viaja dentro de la URL: no registrar URL de la API de Telegram ni errores de `fetch` en bruto.
- La URL de ping de healthchecks.io.
- El contenido de `process.env` o del objeto de configuración completo.
- Objetos de error sin filtrar (pueden arrastrar URL y cabeceras).

Medidas: una función de redacción única por la que pase todo lo que se registra (lista de claves prohibidas + patrones), una prueba automática que falle si un secreto de ejemplo aparece en la salida, y rotación de logs con retención limitada. Freqtrade 2026.9 incorporó redacción de configuración como endurecimiento de seguridad.

### 5.4 Rotación

- Rotar cada ~90 días y **de inmediato** si: el portátil sale a reparar, se pierde o se presta; un secreto aparece en un log, captura o commit; hay actividad no reconocida; se cambia de máquina (al migrar al VPS, clave nueva).
- Procedimiento: crear la clave nueva (mismos permisos, IP en lista blanca) → actualizar `.env` → reiniciar → comprobar lectura de saldo y una orden mínima → **eliminar la clave antigua** → anotar la fecha.
- Si el token de Telegram se filtra: `/token` en BotFather y actualizar `.env`.
- Un secreto que ha entrado en git se considera comprometido aunque se borre después: rotarlo.

---

## 6. Construir frente a reutilizar

| | Bot propio (Node + ccxt) | Freqtrade | Hummingbot | Jesse | OctoBot |
|---|---|---|---|---|---|
| Lenguaje | TypeScript | Python ≥ 3.11 | Python | Python | Python |
| Madurez | Ninguna: todo por probar | Muy alta; versión 2026.9 del 29-09-2026, publicaciones frecuentes | Alta; orientado a creación de mercado y arbitraje | Media-alta; fuerte en investigación | Media; 6,7 k estrellas en GitHub |
| Modo simulado | Hay que escribirlo (el proyecto ya tiene un broker simulado) | *Dry-run* integrado | *Paper trade* integrado | Sí, vía el plugin de operativa real | Sí |
| Backtesting | Hay que escribirlo | Sí, más hyperopt y FreqAI | Sí, desde Dashboard [3º] | Sí; es su punto fuerte | Sí |
| Móvil | Hay que escribirlo | Telegram completo + FreqUI | Condor (Telegram) + Dashboard | Panel web; notificaciones | Web, Telegram y app iOS/Android (según su README) |
| Persistencia | `node:sqlite` | SQLite | Propia | Propia | Propia |
| Windows sin Docker | **Nativo**: ya funciona | Posible con `setup.ps1`, pero la documentación "recomienda encarecidamente" Docker; WSL como alternativa | **No**: exige WSL2; hay que usar la terminal de Ubuntu | Docker recomendado; instalación nativa posible [NV] | **Sí**: ejecutable para Windows |
| Coste | Tiempo propio | Gratis (GPL) | Gratis (Apache-2.0) | La operativa real requiere **licencia del plugin** (precio [NV]) | Gratis (GPL-3.0) |

Fuentes: https://www.freqtrade.io/en/stable/ · https://www.freqtrade.io/en/stable/installation/ · https://hummingbot.org/client/installation/ · https://docs.jesse.trade/docs/livetrade · https://github.com/Drakkar-Software/OctoBot

Valoración honesta:

- **El mayor riesgo de un bot propio no es la estrategia, es la ejecución**: órdenes duplicadas, estado desincronizado, stops que no se colocan, redondeos y comisiones. Freqtrade lleva años encontrando y corrigiendo esos fallos con dinero real de miles de usuarios. Un bot nuevo los va a redescubrir. El propio código lo reconoce: `src/broker.ts` indica que el broker real "NO se ha probado contra un exchange" [LOCAL].
- Si el objetivo es **operar pronto con infraestructura probada**, lo de menor riesgo es Freqtrade en un VPS Linux con Docker, no en este portátil.
- Construir está justificado si el objetivo incluye **aprender y controlar cada línea**, el alcance se mantiene pequeño (spot, pocos pares, órdenes simples) y se acepta una fase larga de simulación y luego capital mínimo.
- Con las restricciones dadas (Windows sin Docker ni Python, stack ya decidido), las únicas opciones que funcionan hoy sin instalar más son el bot propio y el ejecutable de OctoBot.
- Hummingbot resuelve otro problema (creación de mercado); Jesse es excelente para investigar, pero su operativa real es de pago.
- Opción intermedia razonable: usar Freqtrade en *dry-run* como **referencia** para contrastar el comportamiento del bot propio con la misma estrategia.

Piezas de diseño que conviene imitar:

1. **Modo simulado como ciudadano de primera**: mismo código y misma base de datos que el real; solo cambia el adaptador que habla con el exchange (Freqtrade *dry-run*).
2. **Bucle con orden fijo**: leer persistencia → actualizar órdenes desde el exchange → tiempos de espera → salidas → entradas. Las salidas siempre antes que las entradas.
3. **Stop en el exchange + salida de emergencia** a mercado si no se puede colocar.
4. **Backtesting con el mismo código de estrategia** que la operativa real, con comisiones y deslizamiento.
5. **Protecciones globales**: pausa tras N pérdidas seguidas, límite de pérdida diaria, enfriamiento por par, máximo de operaciones abiertas.
6. **Telegram con lista de autorizados** y comandos acotados, con `/pause` o `/stopentry` separado de `/stop`.
7. **Redacción de secretos** en configuración y logs.
8. **Comprobación de desfase de reloj** contra el exchange.
9. **Validación al arrancar**: mínimos, precisión y tipos de orden que admite cada par; negarse a arrancar si la configuración no cuadra.
10. **Separación investigación / ejecución** (Jesse) y **conectores normalizados** por exchange (Hummingbot), para que la estrategia no conozca detalles del exchange.

---

## 7. Estado de `node:sqlite` y del TypeScript nativo en Node 24

Versión instalada: **v24.21.0** [LOCAL]. Documentación consultada: la de esa misma versión.

### 7.1 Ciclo de vida de Node 24

- Node 24 "Krypton": publicado el 06-05-2025, **LTS activo** desde el 28-10-2025, pasa a **mantenimiento el 20-10-2026** y fin de vida el **30-04-2028**. Node 26 pasa a LTS el 28-10-2026. Las fechas pueden cambiar.
  Fuente: https://github.com/nodejs/Release
- Conclusión: Node 24 es una base válida hasta abril de 2028. Planificar el paso a Node 26 LTS durante 2027.

### 7.2 `node:sqlite`

Fuente: https://nodejs.org/docs/latest-v24.x/api/sqlite.html [DOC]

- Índice de estabilidad: **1.2 - Candidata a versión final** desde **v24.15.0**. No es aún "estable" (2).
- Historial: añadido en v22.5.0; sin bandera desde v22.13.0 / v23.4.0; candidata desde v24.15.0.
- En este equipo, `require('node:sqlite')` y una consulta **no emiten ningún aviso experimental** [LOCAL].
- Incoherencia menor: la página de opciones de línea de comandos sigue describiendo `--no-experimental-sqlite` como "sin bandera pero aún experimental".
- API **síncrona** (`DatabaseSync`, `StatementSync`). Opciones relevantes: `timeout` (desde v24.0.0, espera ante bloqueo), `enableForeignKeyConstraints` (por defecto `true`), `readOnly`, `readBigInts`, `defensive` (por defecto `true` desde v24.14.0).
- `backup()` disponible (añadido en v23.8.0).
- No hay método propio para WAL: se activa con `PRAGMA`.
- Riesgo residual: al ser candidata, la API puede cambiar "si aparecen problemas significativos". Mitigación: **encapsular todo el acceso en un único módulo** (el proyecto ya tiene `src/store.ts`), fijar la versión de Node y ejecutar las pruebas al actualizar. El plan B es `better-sqlite3`, de API muy parecida.
- Enteros mayores de 2^53: usar `readBigInts` o guardar importes como texto o enteros en unidades mínimas.

### 7.3 Ejecución nativa de TypeScript

Fuente: https://nodejs.org/docs/latest-v24.x/api/typescript.html [DOC]

- El borrado de tipos (*type stripping*) es **estable (índice 2) desde v24.12.0**; sin aviso experimental desde v24.3.0; activado por defecto desde v23.6.0.
- **No se admite** sin `--experimental-transform-types` (candidata, 1.2): `enum`, `namespace` con código en tiempo de ejecución, propiedades de parámetro en constructores (`constructor(private x: number)`) y alias de importación (`import x = …`).
- Otras limitaciones:
  - Las **extensiones son obligatorias** en las importaciones: `import './modulo.ts'`.
  - Hay que usar **`import type`** para tipos; importar un tipo como valor falla en ejecución.
  - **`tsconfig.json` se ignora** en ejecución: no hay `paths` ni conversión a versiones antiguas. Para alias, usar importaciones de subruta con `#`.
  - `.tsx` no está soportado. Los **decoradores** tampoco.
  - Node **se niega a ejecutar TypeScript dentro de `node_modules`**.
- Node **no comprueba tipos**: solo los borra. La comprobación es un paso aparte (`tsc --noEmit`).
- Alternativa a `enum`: objeto `as const` más tipo unión derivado.

Estado del proyecto [LOCAL]: `tsconfig.json` ya tiene `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions` y `noEmit`, que son las opciones que hacen que el compilador rechace justo lo que Node no puede ejecutar. `package.json` ya define `typecheck` (`tsc --noEmit`). Recomendación: ejecutar `npm run typecheck` y `npm test` **antes de cada despliegue**, porque un error de tipos no impide que Node arranque el bot.

---

## 8. Fiscalidad y registros: campos a guardar

Esto no es asesoramiento fiscal. Las reglas (método de valoración, modelos, plazos) dependen del país de residencia: confirmarlas con un profesional. La lista es lo que conviene tener guardado para poder reconstruir cualquier cálculo después.

Por cada **ejecución** (una orden puede tener varias):

- Identificador interno de la ejecución.
- Identificador de la ejecución en el exchange (`tradeId`).
- Identificador de la orden en el exchange (`orderId`) y `clientOrderId` propio.
- Exchange y cuenta o subcuenta.
- Fecha y hora **en UTC** con milisegundos (y la zona horaria local usada en los informes).
- Par (`BTC/EUR`), activo base y activo de cotización.
- Lado: compra o venta.
- Tipo de orden (mercado, límite, stop) y si fue creadora o tomadora de liquidez.
- Cantidad ejecutada (activo base).
- Precio unitario de ejecución.
- Importe total (activo de cotización).
- Comisión: importe y **moneda de la comisión**.
- Contravalor de la comisión en la moneda fiscal.
- Tipo de cambio a la moneda fiscal (p. ej. EUR) en ese instante y **fuente** del tipo de cambio.
- Contravalor de la operación en la moneda fiscal.

Por cada **operación cerrada** (entrada + salida):

- Identificador de posición o lote.
- Fecha y valor de adquisición, con comisiones.
- Fecha y valor de transmisión, con comisiones.
- Método de emparejamiento de lotes aplicado (p. ej. FIFO) y lotes consumidos.
- Ganancia o pérdida en la moneda fiscal.
- Periodo de tenencia.
- Estrategia y motivo de entrada y de salida (útil para auditoría, no fiscal).

Otros movimientos que también hay que registrar:

- Depósitos y retiradas (fecha, activo, cantidad, comisión, origen o destino, identificador de transacción).
- Conversiones entre criptomonedas, incluidas las de "polvo" y el pago de comisiones en un tercer activo (p. ej. BNB).
- Recompensas, intereses, *airdrops*, devoluciones de comisiones.
- Saldos por activo a **31 de diciembre** y su valoración, con la fuente del precio.
- Transferencias entre cuentas propias (para no contarlas como ventas).

Conservación:

- Respuesta **en bruto** del exchange de cada orden y ejecución (JSON), sin modificar.
- Exportaciones oficiales del exchange (CSV o extractos) descargadas cada trimestre y al cierre del año: son el respaldo si los datos del bot se pierden o el exchange cierra.
- Registros de **solo inserción**; las correcciones se añaden como asientos nuevos.
- Operaciones **simuladas y reales en tablas o bases separadas**, o con una marca inequívoca: mezclarlas falsea cualquier informe.
- Copias de seguridad según 4.8 y conservación durante los años que exija la normativa local.

---

## 9. Lista de comprobación de puesta en producción

### A. Equipo (portátil)

- [ ] Enchufado a la corriente, sobre superficie ventilada; límite de carga de batería activado si existe.
- [ ] `powercfg`: suspensión e hibernación en CA = nunca; acción de tapa = "No hacer nada" (1.2).
- [ ] Verificado con `powercfg /qh SCHEME_CURRENT SUB_BUTTONS LIDACTION` que el índice es 0.
- [ ] Prueba real: tapa cerrada 30 minutos y el latido no se interrumpe.
- [ ] Windows Update: horas activas ampliadas y directiva "notificar para descargar e instalar" (1.3).
- [ ] Ventana semanal de mantenimiento fijada en el calendario.
- [ ] Red: cable Ethernet si es posible; si no, ahorro de energía del wifi en "Rendimiento máximo".
- [ ] Reloj: `w32tm /query /status` muestra origen NTP y sincronización reciente (4.5).
- [ ] Disco cifrado y cuenta de Windows con contraseña.

### B. Supervisión

- [ ] Tarea `InversorJP-Bot` registrada desde el XML (1.6).
- [ ] Prueba: matar `node.exe` y comprobar que se relanza en 5 minutos como máximo.
- [ ] Prueba: reiniciar Windows **sin iniciar sesión** y comprobar que el bot arranca.
- [ ] Bloqueo de instancia única: un segundo arranque manual se niega a ejecutarse.
- [ ] Los logs se escriben a fichero, rotan y no contienen secretos.

### C. Secretos y exchange

- [ ] `.env` fuera de git (`git status` limpio) y `.env.example` presente.
- [ ] Clave API: lectura + trading spot, **retirada desactivada**, lista blanca de IP.
- [ ] Claves distintas para simulación y real; subcuenta con capital limitado si es posible.
- [ ] Segundo factor, código antiphishing y lista blanca de retiradas en la cuenta.
- [ ] Fecha de rotación anotada.

### D. Robustez del bot

- [ ] Reconciliación al arrancar probada con: orden abierta, orden parcialmente ejecutada, orden desconocida y stop ausente.
- [ ] `clientOrderId` persistido antes de enviar; prueba de tiempo de espera agotado sin orden duplicada.
- [ ] Ejecuciones parciales y comisión en activo base cubiertas por pruebas.
- [ ] Todo stop de protección está en el exchange; salida de emergencia implementada.
- [ ] Backoff con jitter, cortacircuitos y respeto de `Retry-After`.
- [ ] Comprobación de desfase de reloj contra el exchange al arrancar y cada hora.
- [ ] Detección de suspensión (salto del temporizador) con reconciliación posterior.
- [ ] Límites de riesgo globales: pérdida diaria máxima, tamaño máximo por operación, máximo de posiciones.
- [ ] `/pausa` y `/reanudar` persistentes entre reinicios.
- [ ] `npm run typecheck` y `npm test` en verde.

### E. Datos

- [ ] SQLite en WAL con `synchronous=FULL` y `timeout` configurado.
- [ ] Copia diaria automática, con su propia comprobación de hombre muerto.
- [ ] Copias fuera del portátil; restauración ensayada una vez.
- [ ] `data/` fuera de carpetas sincronizadas con la nube.
- [ ] Campos fiscales de la sección 8 presentes en el esquema.

### F. Monitorización

- [ ] Bot de Telegram creado; solo responde al `chat_id` autorizado (probado desde otra cuenta).
- [ ] healthchecks.io: comprobación del bucle (periodo 1-5 min, gracia 5 min) con **dos** canales de alerta.
- [ ] Prueba: detener el bot y recibir la alerta en ~10 minutos.
- [ ] Panel escuchando solo en `127.0.0.1`; accesible desde el móvil por Tailscale con los datos móviles (wifi de casa desactivado).
- [ ] Ningún puerto abierto en el router.

### G. Salida gradual

- [ ] Mínimo 2-4 semanas en modo simulado sin incidentes ni descuadres de reconciliación.
- [ ] Primera fase real con el **importe mínimo** del exchange y un solo par.
- [ ] Plan manual escrito: cómo cerrar todo desde la app del exchange y cómo desactivar la clave API.
- [ ] Decisión tomada sobre la migración al VPS antes de aumentar capital (2.3).

---

## 10. No verificado

Lo siguiente no pudo confirmarse en una fuente primaria o no se ha ejecutado. Comprobar antes de depender de ello.

**Comandos y configuración no ejecutados** (por la restricción de no modificar el sistema):

1. El XML de la tarea (1.6) y `schtasks /create /xml`: los elementos están verificados uno a uno en el esquema, pero el archivo completo no se ha importado. Validar tras importar con `schtasks /query /tn "InversorJP-Bot" /xml`. En particular: codificación UTF-16 del archivo, repetición indefinida del `TimeTrigger` sin `Duration`, y que la cuenta tenga contraseña.
2. Qué considera exactamente "fallo" el Programador para `RestartOnFailure` (código de salida distinto de 0 o solo fallo al iniciar). Por eso el diseño no depende de ello.
3. Que `WorkingDirectory` deba ir sin comillas con rutas con espacios.
4. Si `LogonType` `S4U` impide las conexiones salientes a Internet (la documentación dice "sin acceso a la red"); se evitó usando `Password`.
5. Los comandos `reg add` de Windows Update (1.3): derivados de claves documentadas, no ejecutados. Microsoft desaconseja editar el registro. No se verificó si `AUOptions=2` requiere además `NoAutoUpdate=0`, ni la subcarpeta exacta de la directiva en `gpedit.msc` de Windows 11.
6. Los comandos `powercfg` que modifican ajustes: la sintaxis está verificada en la documentación y los GUID se leyeron de este equipo, pero no se aplicaron.
7. `w32tm /config …` y `Set-Service w32time`: no ejecutados. Tampoco se determinó **por qué** el reloj figura sin sincronizar (la consulta del origen devolvió "Acceso denegado" sin privilegios de administrador).
8. Comandos de Servy, NSSM, Tailscale, cloudflared y la unidad `systemd`: tomados de su documentación, no ejecutados. No se verificó el identificador de `winget` de Tailscale ni de cloudflared.
9. Comportamiento exacto de las aplicaciones de escritorio durante *Modern Standby* y el efecto real de cerrar la tapa con "No hacer nada" en este modelo concreto.

**Precios y condiciones**:

10. Hetzner: el precio del CX23 (5,49 €) viene de la documentación oficial; el suplemento de IPv4 (0,50 €) y la falta de disponibilidad, de terceros. La página oficial de precios no mostró cifras al consultarla.
11. Contabo: el precio a 1 mes no quedó claro en la página oficial (se vio "5,50 €" asociado a 24 meses y una segunda cifra ambigua); los 6,31 USD/mes son de un comparador.
12. OVH: no se verificó el precio sin compromiso ni la duración exacta del compromiso en la web española.
13. Fly.io: la tabla de precios se calcula con JavaScript; solo se obtuvieron las tarifas base por segundo, no el total mensual de una máquina.
14. Cloudflare Access gratuito hasta 50 usuarios: fuente de terceros; la página oficial de planes no mostró el dato.
15. Tailscale: una búsqueda devolvió también "3 usuarios / 100 dispositivos"; se tomó el dato de la página oficial de precios (6 usuarios, dispositivos ilimitados).
16. Jesse: precio de la licencia de operativa real (la página devolvió 403). OctoBot: la guía oficial de instalación devolvió 403; los datos proceden de su README de GitHub. Licencia de Hummingbot no comprobada.
17. Pausa de actualizaciones de Windows hasta 5 semanas: fuente de terceros.

**Exchange y bibliotecas**:

18. Una búsqueda devolvió información contradictoria sobre una antigua regla de Binance de caducidad a 90 días para claves sin restricción de IP. Se usó la regla de la ayuda oficial actual (clave HMAC sin restricción de IP = solo lectura); confirmarla al crear la clave.
19. Compatibilidad de ccxt 4.5.84 con claves Ed25519 de Binance y forma exacta de pasar `clientOrderId`, `stopLossPrice` y órdenes OCO por `params`: el manual confirma que existen, no se probaron.
20. Que `verbose: true` de ccxt vuelque cabeceras con la clave API.
21. Tipos de orden de stop disponibles en cada par concreto y restricciones de los exchanges por país de la IP.
22. Disponibilidad de Binance u otro exchange para el país de residencia del usuario: fuera del alcance.
23. Tope del parámetro `timeout` de `getUpdates` y la regla de que un bot no puede iniciar conversación: no localizados en las páginas consultadas.

**Node**:

24. La ausencia de aviso experimental de `node:sqlite` se observó en v24.21.0 en este equipo; no se comprobó en qué versión exacta desapareció.
25. El borrado de tipos conserva los números de línea (no hacen falta mapas de código): conocido, no localizado en la página consultada.

---

## 11. Fuentes

Windows
- https://learn.microsoft.com/windows-hardware/design/device-experiences/powercfg-command-line-options
- https://learn.microsoft.com/windows/deployment/update/waas-restart
- https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-create
- https://learn.microsoft.com/windows/win32/taskschd/task-scheduler-schema-elements
- https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element
- https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-interval-restarttype-element
- https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-executiontimelimit-settingstype-element
- https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-multipleinstancespolicy-settingstype-element
- https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element
- https://learn.microsoft.com/powershell/module/scheduledtasks/new-scheduledtasksettingsset
- https://learn.microsoft.com/powershell/module/scheduledtasks/register-scheduledtask
- https://learn.microsoft.com/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings
- https://learn.microsoft.com/windows-server/identity/ad-ds/manage/component-updates/winlogon-automatic-restart-sign-on--arso-

Supervisión
- https://nssm.cc/download · https://nssm.cc/usage
- https://github.com/aelassas/servy · https://github.com/aelassas/servy/wiki/Servy-CLI
- https://pm2.keymetrics.io/docs/usage/startup/ · https://github.com/jessety/pm2-installer

VPS y nube
- https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- https://costgoat.com/pricing/hetzner · https://www.cloudhim.com/cloud-costs/hetzner-cx22-pricing-2026
- https://contabo.com/en/vps/ · https://vpsarena.app/providers/contabo
- https://www.ovhcloud.com/es-es/vps/ · https://www.ovhcloud.com/en/vps/
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- https://docs.fly.io/about/pricing/ · https://docs.fly.io/about/free-trial/
- https://railway.com/pricing · https://docs.railway.com/networking/static-outbound-ips

Telegram y acceso remoto
- https://core.telegram.org/bots/api · https://core.telegram.org/bots/faq · https://core.telegram.org/bots/features
- https://tailscale.com/pricing · https://tailscale.com/docs/features/tailscale-serve
- https://tailscale.com/docs/reference/tailscale-cli/serve · https://tailscale.com/docs/how-to/run-unattended
- https://tailscale.com/docs/install/windows
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/windows/
- https://costbench.com/software/business-vpn/cloudflare-zero-trust/

Exchange, ccxt y robustez
- https://docs.ccxt.com/docs/manual
- https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security
- https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits
- https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints
- https://www.binance.com/en/support/faq/detail/360002502072
- https://docs.kraken.com/api/docs/rest-api/cancel-all-orders-after
- https://healthchecks.io/pricing/ · https://healthchecks.io/docs/ · https://healthchecks.io/integrations/telegram/
- https://www.sqlite.org/wal.html · https://www.sqlite.org/lang_vacuum.html · https://www.sqlite.org/howtocorrupt.html

Proyectos de referencia
- https://www.freqtrade.io/en/stable/ · https://www.freqtrade.io/en/stable/installation/
- https://www.freqtrade.io/en/stable/bot-basics/ · https://www.freqtrade.io/en/stable/stoploss/
- https://www.freqtrade.io/en/stable/telegram-usage/ · https://github.com/freqtrade/freqtrade/releases/latest
- https://hummingbot.org/installation/ · https://hummingbot.org/client/installation/
- https://docs.jesse.trade/docs/livetrade
- https://github.com/Drakkar-Software/OctoBot

Node
- https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- https://nodejs.org/docs/latest-v24.x/api/typescript.html
- https://nodejs.org/docs/latest-v24.x/api/cli.html
- https://github.com/nodejs/Release
