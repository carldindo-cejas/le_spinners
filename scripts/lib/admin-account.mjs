// Testable provisioning SQL. Callers never print credential inputs or this statement.
const sql=value=>`'${String(value).replace(/'/g,"''")}'`;
export function adminAccountSql({id,email,name,hash,salt,iterations,scheme,role,now,changeId,expected}) {
  if(role!=='admin'&&role!=='staff')throw Error('Invalid administrative role');
  const conflict=expected
    ? `DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,password_salt=excluded.password_salt,
      password_iterations=excluded.password_iterations,password_scheme=excluded.password_scheme,role=excluded.role,
      status='active',auth_change_id=excluded.auth_change_id,updated_at=excluded.updated_at
      WHERE users.id=${sql(expected.id)} AND users.auth_version=${Number(expected.auth_version)}`
    : 'DO NOTHING';
  return `INSERT INTO users(id,email,name,password_hash,password_salt,password_iterations,password_scheme,role,membership,status,auth_change_id,created_at,updated_at)
    VALUES(${sql(id)},${sql(email)},${sql(name)},${sql(hash)},${sql(salt)},${Number(iterations)},${sql(scheme)},${sql(role)},'none','active',${sql(changeId)},${Number(now)},${Number(now)})
    ON CONFLICT(email) ${conflict};
    DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=${sql(email)} AND auth_change_id=${sql(changeId)});
    SELECT COUNT(*) AS applied FROM users WHERE email=${sql(email)} AND auth_change_id=${sql(changeId)};`;
}
