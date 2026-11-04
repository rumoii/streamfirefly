use std::sync::Mutex;
use std::sync::MutexGuard;

/// A panic while holding a lock must not take the whole host down with the
/// next thread that touches the same data: recover the inner value and keep
/// going. The protected data may reflect a half-finished update, which is
/// accepted over a cascading crash.
pub(crate) trait LockExt<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::LockExt;
    use std::sync::Mutex;

    #[test]
    fn lock_or_recover_recovers_a_poisoned_mutex() {
        let mutex = Mutex::new(41u32);
        let panicker = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            *mutex.lock_or_recover() += 1;
            panic!("poison while holding the lock");
        }));
        assert!(panicker.is_err());
        let mut guard = mutex.lock_or_recover();
        *guard += 1;
        assert_eq!(*guard, 43);
    }
}
