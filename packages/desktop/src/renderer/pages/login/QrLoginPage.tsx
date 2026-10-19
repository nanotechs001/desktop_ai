/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Result, Spin } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@renderer/hooks/context/AuthContext';

type QrLoginState = 'signingIn' | 'expired';
type WindowWithReconnect = Window & { __websocketReconnect?: () => void };

/**
 * Landing page for the sign-in QR code: trades the one-time token in the URL for a session.
 * Any failure reads as an expired code, since the token is single-use and short-lived.
 */
const QrLoginPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const token = useSearchParams()[0].get('token');
  const [state, setState] = useState<QrLoginState>(token ? 'signingIn' : 'expired');
  // The token is single-use, so a re-run of the effect must not spend it twice.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!token || startedRef.current) return;
    startedRef.current = true;

    const signIn = async () => {
      try {
        const response = await fetch('/api/auth/qr-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ qr_token: token }),
        });
        if (!response.ok) {
          setState('expired');
          return;
        }
        await refresh();
        // Re-enable WebSocket reconnection after a successful sign-in, as the password login does.
        (window as WindowWithReconnect).__websocketReconnect?.();
        void navigate('/', { replace: true });
      } catch (error) {
        console.error('QR login request failed:', error);
        setState('expired');
      }
    };
    void signIn();
  }, [navigate, refresh, token]);

  return (
    <div className='flex items-center justify-center min-h-100vh bg-base'>
      {state === 'signingIn' ? (
        <Spin tip={t('login.qrSigningIn')} />
      ) : (
        <Result
          status='warning'
          title={t('login.qrExpired')}
          extra={
            <Button type='primary' onClick={() => void navigate('/login', { replace: true })}>
              {t('login.qrBackToLogin')}
            </Button>
          }
        />
      )}
    </div>
  );
};

export default QrLoginPage;
