pub fn login_user(email: &str, password: &str) -> bool {
    !email.is_empty() && !password.is_empty()
}

pub struct SessionStore;
