const quote=value=>`'${String(value).replace(/'/g,"''")}'`;
/** Operator-controlled recovery preserves ownership, status, membership and role. */
export function accountRecoverySql({id,version,hash,salt,iterations,scheme,now,changeId,operator}) {
  if(!Number.isSafeInteger(version) || version<1 || !operator?.trim())throw Error('Recovery needs a current version and operator');
  return `UPDATE users SET password_hash=${quote(hash)},password_salt=${quote(salt)},password_iterations=${Number(iterations)},
    password_scheme=${quote(scheme)},auth_change_id=${quote(changeId)},updated_at=${Number(now)}
    WHERE id=${quote(id)} AND auth_version=${version};
    DELETE FROM sessions WHERE user_id=${quote(id)} AND EXISTS (SELECT 1 FROM users WHERE id=${quote(id)} AND auth_change_id=${quote(changeId)});
    INSERT INTO audit_log(actor_id,action,entity,entity_id,detail,created_at)
    SELECT NULL,'operator_account_recovery','user',id,${quote('Operator: '+operator)},${Number(now)} FROM users WHERE id=${quote(id)} AND auth_change_id=${quote(changeId)};
    SELECT COUNT(*) AS applied FROM users WHERE id=${quote(id)} AND auth_change_id=${quote(changeId)};`;
}
