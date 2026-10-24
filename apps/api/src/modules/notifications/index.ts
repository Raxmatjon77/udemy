// Public facade of the notifications context: the only file other modules may import.
// No in-process consumers (design §3): only AppModule imports the module.
export { NotificationsModule } from './notifications.module';
