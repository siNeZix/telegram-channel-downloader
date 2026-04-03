# План исправления параллельности скачивания

## Найденные проблемы

### 1. КРИТИЧЕСКАЯ: Блокирующая задержка внутри цикла (строка 558)
```javascript
if (shouldDownload && !fileExist && textMatchesFilters) {
    await wait(0.2);  // ← ЭТА СТРОКА БЛОКИРУЕТ ЦИКЛ!
    logMessage.info(`Start Downloading file ${mediaPath}...`);
    queuedDownloads += 1;
    downloadPromise = downloadMessageMedia(...);
    activeDownloads.add(downloadPromise);
}
```

**Проблема:** `await wait(0.2)` внутри цикла `for` делает каждую итерацию последовательной. Даже если промисы выполняются параллельно, сам цикл ждёт 0.2 секунды перед созданием каждого нового промиса.

**Расчёт:** При batch из 100 файлов для скачивания:
- 100 × 0.2 сек = **20 секунд** только на ожидание перед стартом загрузок!
- Это полностью нивелирует параллельность

### 2. Отсутствие логирования активных загрузок
Нет видимости текущего количества параллельных загрузок в логах.

### 3. Неэффективный контроль параллельности
`Promise.race()` ждёт только один промис, но не гарантирует точное соблюдение лимита.

---

## План исправления

### Шаг 1: Убрать блокирующую задержку из цикла
**Файл:** `modules/messages.js`, строка 558

**Было:**
```javascript
if (shouldDownload && !fileExist && textMatchesFilters) {
    await wait(0.2);  // УДАЛИТЬ ЭТУ СТРОКУ
    logMessage.info(`Start Downloading file ${mediaPath}...`);
```

**Стало:**
```javascript
if (shouldDownload && !fileExist && textMatchesFilters) {
    logMessage.info(`Start Downloading file ${mediaPath}...`);
```

### Шаг 2: Добавить логирование активных загрузок
**Файл:** `modules/messages.js`, после строки 622

**Добавить:**
```javascript
// Логируем текущее количество активных загрузок каждые 5 файлов
if (queuedDownloads % 5 === 0) {
    logMessage.info(
        `Active downloads: ${activeDownloads.size}/${floodState.currentParallelLimit}, queued: ${queuedDownloads}`
    );
}
```

### Шаг 3: (Опционально) Добавить задержку между батчами
Если нужна задержка для снижения нагрузки на API, добавить её между батчами сообщений, а не внутри цикла:

**Файл:** `modules/messages.js`, после строки 660

**Было:**
```javascript
offsetId = messages[messages.length - 1].id;
updateLastSelection({ messageOffsetId: offsetId });
await wait(3);
```

**Стало:**
```javascript
offsetId = messages[messages.length - 1].id;
updateLastSelection({ messageOffsetId: offsetId });
// Задержка между батчами для снижения нагрузки на API
await wait(1);  // Уменьшено с 3 до 1 секунды
```

---

## Ожидаемый результат

1. **Ускорение в 10-20 раз** при скачивании файлов
   - Убираем 0.2 сек × N файлов = экономия десятков секунд на каждый батч
   
2. **Видимость параллельности в логах**
   - Логи покажут `Active downloads: 15/20` вместо неинформативных сообщений
   
3. **Корректная работа скользящего окна**
   - `Promise.race()` будет работать как задумано - параллельно до лимита

---

## Тестирование

После исправления проверить:
1. В логах видно `Active downloads: X/20` с X > 1
2. Скорость скачивания увеличилась
3. Нет ошибок flood control
4. Файлы скачиваются корректно
