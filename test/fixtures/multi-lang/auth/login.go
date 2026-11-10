package auth

func LoginUser(email, password string) bool {
	return len(email) > 0 && len(password) > 0
}

type SessionStore struct{}
