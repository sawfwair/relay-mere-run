#!/usr/bin/env python3
"""Qualify an already enrolled, dedicated Node through account-scoped Relay APIs.

This does not rent a GPU, refresh/copy a desktop identity, or claim Animatic
delivery. Mutations are single-attempt and require --execute. A lost submission
response is indeterminate, never grounds to submit a replacement job.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import shutil
import struct
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

MODEL = 'image-zimage-nano'
TERMINAL = {'complete', 'failed', 'cancelled'}


class QualificationError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise QualificationError('Redirect rejected; account bearer stays on Relay origin')


def make_api(token, opener=None, token_provider=None):
    opener = opener or urllib.request.build_opener(NoRedirect())
    def api(method, path, body=None):
        request = urllib.request.Request('https://relay.mere.run/api' + path,
            data=None if body is None else json.dumps(body).encode(), method=method,
            headers={'Authorization': 'Bearer ' + (token_provider() if token_provider else token), 'Content-Type': 'application/json',
                     'User-Agent': 'animatic-node-qualification/1.0'})
        with opener.open(request, timeout=30) as response:
            return json.load(response)
    return api


def provider_access_token(command, owner, runner=subprocess.run, now=time.time):
    try:
        response = runner(command, check=True, timeout=40, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if len(response.stdout) > 32 * 1024:
            raise ValueError('oversized provider response')
        value = json.loads(response.stdout)
        token = value['access_token']
        if not isinstance(token, str):
            raise ValueError('invalid token type')
        payload = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        if (not isinstance(claims, dict) or set(value) != {'access_token'} or claims.get('sub') != owner or
                claims.get('client_id') != 'animatic-cli' or claims.get('exp', 0) <= now() + 60):
            raise ValueError('wrong owner, session, or expired provider token')
        return token
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError, TypeError):
        # Never expose provider stdout/stderr: either can contain credentials.
        raise QualificationError('Independent Animatic access-token provider failed validation') from None


def parse_token_provider(value):
    if value is None:
        return None
    try:
        command = json.loads(value)
        if (not isinstance(command, list) or not command or
                not all(isinstance(arg, str) and arg and '\0' not in arg for arg in command) or
                not pathlib.Path(command[0]).is_absolute()):
            raise ValueError('expected absolute executable and arguments')
        return command
    except (ValueError, TypeError):
        raise QualificationError('Token provider must be a JSON argument array with an absolute executable') from None


def png_metadata(data):
    if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise QualificationError('Expected a PNG artifact')
    width, height = struct.unpack('>II', data[16:24])
    if (width, height) != (512, 512):
        raise QualificationError('Unexpected generated dimensions')
    return {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
            'width': width, 'height': height, 'validation': 'PNG signature and IHDR; full decode is a separate gate'}


def decode_image(path):
    try:
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'null', '-'],
            check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except (OSError, subprocess.SubprocessError):
        raise QualificationError('Delivered image did not decode successfully with FFmpeg') from None


def revoke_dedicated_refresh(post, refresh_token):
    if not refresh_token or not refresh_token.startswith('odrt_'):
        raise QualificationError('Expected the dedicated Node device refresh token')
    status, _ = post('/oauth/revoke', {'client_id': 'mererun-node', 'token': refresh_token})
    if status != 200:
        raise QualificationError('Dedicated refresh revocation endpoint rejected the request')
    # Revocation returns 200 even for unknown tokens. Only an actual rejected
    # refresh proves this credential can no longer extend its session.
    status, response = post('/oauth/token', {'client_id': 'mererun-node',
        'grant_type': 'refresh_token', 'refresh_token': refresh_token})
    if status != 400 or response.get('error') != 'invalid_grant':
        raise QualificationError('Dedicated refresh revocation did not produce invalid_grant')


def selected_node(status, fleet, device_id, expected_name):
    if 'required_device_id' not in status.get('placement_constraints', []):
        raise QualificationError('Relay does not advertise enforced device placement; deploy reviewed support first')
    connected = [node for node in status.get('agents', []) if node.get('device_id') == device_id]
    inventory = [node for node in fleet.get('nodes', []) if node.get('device_id') == device_id]
    if len(connected) != 1 or len(inventory) != 1:
        raise QualificationError('Dedicated device is not uniquely connected to this account')
    node = inventory[0]
    if node.get('device_name') != expected_name or not expected_name.startswith('animatic-node-qualification-'):
        raise QualificationError('Device does not match the owned qualification Pod name')
    if node.get('status') != 'online' or node.get('current_job_id'):
        raise QualificationError('Dedicated node must be idle before qualification')
    if not node.get('capacity', {}).get('lease_protocol'):
        raise QualificationError('Node did not advertise lease support')
    if node.get('capabilities', {}).get('hosting', {}).get('kind') != 'runpod':
        raise QualificationError('Expected explicit RunPod hosting declaration')
    return node


def run(api, device_id, expected_name, owner_id, output, receipt, save,
        sleep=time.sleep, polls=400, revoke=False, decode=decode_image):
    """Injectable transport makes authorization/placement/cleanup testable offline."""
    jobs = []
    plan_id = None
    node = selected_node(api('GET', '/status'), api('GET', '/fleet'), device_id, expected_name)
    receipt.update({'deviceId': device_id, 'agentId': node['agent_id'], 'leaseAdvertised': True,
                    'ownerSubjectSha256': hashlib.sha256(owner_id.encode()).hexdigest()})
    save()

    def poll(path, done):
        for _ in range(polls):
            value = api('GET', path)
            if done(value):
                return value
            sleep(3)
        raise QualificationError('Polling deadline reached; inspect saved IDs before any retry')

    def check_job(job):
        if job.get('user_id') != owner_id or job.get('required_device_id') != device_id:
            raise QualificationError('Job ownership or required placement did not round-trip')
        if job.get('agent_id') and job['agent_id'] != node['agent_id']:
            raise QualificationError('Job was assigned to another agent')
        return job

    def submit(label, steps):
        receipt['submissionInFlight'] = label
        save()
        value = api('POST', '/generate', {'kind': 'image', 'model': MODEL,
            'required_device_id': device_id, 'prompt': 'Qualification ' + receipt['nonce'] +
            ': watercolor red sailboat on calm water, no text',
            'width': 512, 'height': 512, 'steps': steps, 'seed': 42, 'direct_image': True})
        job_id = value['job_id']
        jobs.append(job_id)
        receipt[label + 'JobId'] = job_id
        receipt.pop('submissionInFlight', None)
        save()
        return job_id

    try:
        if MODEL not in node.get('runtime', {}).get('installed_models', []):
            plan = api('POST', '/fleet/model-plans', {'target_device_ids': [device_id], 'model_ids': [MODEL]})
            plan_id = plan['plan_id']
            receipt['modelPlanId'] = plan_id
            save()
            api('POST', '/fleet/model-plans/' + plan_id + '/apply', {'accept_model_licenses': False})
            plan = poll('/fleet/model-plans/' + plan_id, lambda p: p.get('state') in {'finished', 'failed', 'cancelled'})
            if plan['state'] != 'finished':
                raise QualificationError('Pinned model installation did not finish')
        receipt['modelInstalled'] = True
        save()

        job_id = submit('generation', 4)
        result = poll('/job/' + job_id, lambda j: check_job(j).get('status') in TERMINAL)
        if result['status'] != 'complete':
            raise QualificationError('Generation did not complete')
        encoded = result.get('result', {}).get('image_data')
        if not isinstance(encoded, str) or len(encoded) > 32 * 1024 * 1024:
            raise QualificationError('Expected bounded direct artifact delivery')
        data = base64.b64decode(encoded, validate=True)
        receipt['image'] = png_metadata(data)
        image_path = output / 'relay-generated.png'
        image_path.write_bytes(data)
        decode(image_path)
        receipt['image']['validation'] = 'PNG dimensions and full FFmpeg decode passed'
        receipt['artifactDelivered'] = True
        save()

        cancel_id = submit('cancellation', 8)
        started = poll('/job/' + cancel_id, lambda j: check_job(j).get('status') == 'generating' or j.get('status') in TERMINAL)
        if started['status'] != 'generating':
            raise QualificationError('Cancellation missed the generating window; not qualified')
        api('DELETE', '/job/' + cancel_id)
        cancelled = poll('/job/' + cancel_id, lambda j: check_job(j).get('status') in TERMINAL)
        if cancelled['status'] != 'cancelled' or cancelled.get('result'):
            raise QualificationError('Cancelled job exposed a result or wrong terminal state')
        poll('/status', lambda s: any(a.get('device_id') == device_id and
            a.get('status') == 'online' and not a.get('current_job_id') for a in s.get('agents', [])))
        sleep(10)
        cancelled = check_job(api('GET', '/job/' + cancel_id))
        if cancelled['status'] != 'cancelled' or cancelled.get('result'):
            raise QualificationError('Late result appeared after cancellation')
        receipt['cancelledWithoutLateResult'] = True
        receipt['nodeAvailableAfterCancellation'] = True
        save()

        if revoke:
            api('PATCH', '/fleet/nodes/' + urllib.parse.quote(device_id, safe=''), {'revoked': True})
            poll('/status', lambda s: all(a.get('device_id') != device_id for a in s.get('agents', [])))
            # The revoked policy must also survive an inventory read. This is
            # fleet-node revocation, not revoking all the user's app sessions.
            fleet = api('GET', '/fleet')
            revoked = next(n for n in fleet['nodes'] if n['device_id'] == device_id)
            if not revoked.get('policy', {}).get('revoked'):
                raise QualificationError('Node revocation was not persisted')
            receipt['fleetNodeRevokedAndDisconnected'] = True
        receipt['status'] = 'passed'
    finally:
        receipt['cleanupErrors'] = []
        for job_id in jobs:
            try:
                job = api('GET', '/job/' + job_id)
                if job.get('status') not in TERMINAL:
                    api('DELETE', '/job/' + job_id)
                api('DELETE', '/job/' + job_id + '/image')
            except Exception:
                receipt['cleanupErrors'].append({'kind': 'job', 'id': job_id})
        if plan_id:
            try:
                plan = api('GET', '/fleet/model-plans/' + plan_id)
                if plan.get('state') not in {'finished', 'failed', 'cancelled'}:
                    api('DELETE', '/fleet/model-plans/' + plan_id)
            except Exception:
                receipt['cleanupErrors'].append({'kind': 'model-plan', 'id': plan_id})
        save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--auth-file', required=True)
    parser.add_argument('--access-token-provider', help='JSON argv for a private independent Animatic-session provider; never a shell string')
    parser.add_argument('--device-id', required=True)
    parser.add_argument('--expected-node-name', required=True)
    parser.add_argument('--receipt-dir', required=True)
    parser.add_argument('--revoke-owned-node', action='store_true')
    parser.add_argument('--revoke-refresh-token', action='store_true', help='Final check after all app work; does not instantly invalidate access JWTs')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('--execute is required; the script creates two GPU jobs')
    if not shutil.which('ffmpeg'):
        parser.error('FFmpeg is required to validate the delivered PNG before paid qualification')
    auth_path = pathlib.Path(args.auth_file)
    if auth_path.stat().st_mode & 0o077:
        parser.error('Auth file must have owner-only permissions')
    auth = json.loads(auth_path.read_text())
    token = auth['access_token']
    payload = token.split('.')[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    if claims.get('client_id') != 'mererun-node' or not claims.get('sub') or claims.get('exp', 0) <= time.time() + 120:
        parser.error('Use the fresh dedicated Node enrollment token; signature/admission are checked by Relay')
    output = pathlib.Path(args.receipt_dir)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    receipt = {'status': 'running', 'nonce': uuid.uuid4().hex, 'model': MODEL,
        'animaticDeliveryQualified': False, 'accountSessionRevocationQualified': False,
        'remoteProcessTerminationQualified': False,
        'limitations': ['Cancellation observes Relay result suppression and released node availability; GPU process termination needs remote telemetry.',
                        'Fleet-node revocation does not revoke the entire account session.']}
    def save():
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    opener = urllib.request.build_opener(NoRedirect())
    provider_command = parse_token_provider(args.access_token_provider)
    token_provider = (lambda: provider_access_token(provider_command, claims['sub'])) if provider_command else None
    receipt['accessCredentialMode'] = 'independent-animatic-provider' if token_provider else 'initial-node-access-only'
    api = make_api(token, opener, token_provider)
    try:
        run(api, args.device_id, args.expected_node_name, claims['sub'], output, receipt, save,
            revoke=args.revoke_owned_node)
        if args.revoke_refresh_token:
            if time.time() >= claims['exp'] - 60:
                raise QualificationError('Node may have rotated its refresh token; refusing to claim revocation using stale local state')
            def broker_post(path, body):
                request = urllib.request.Request('https://mere.world' + path, data=json.dumps(body).encode(),
                    headers={'Content-Type': 'application/json', 'User-Agent': 'animatic-node-qualification/1.0'})
                try:
                    with opener.open(request, timeout=30) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)
            revoke_dedicated_refresh(broker_post, auth.get('refresh_token'))
            receipt['dedicatedRefreshRevokedAndRejected'] = True
            save()
    except Exception as error:
        receipt['status'] = 'failed'
        # Provider errors can echo credentials, prompts, or signed URLs.
        receipt['errorType'] = type(error).__name__
        if isinstance(error, QualificationError):
            receipt['reason'] = str(error)
        save()
    print(json.dumps({'status': receipt['status'], 'receipt': str(output / 'receipt.json')}))
    return 0 if receipt['status'] == 'passed' and not receipt.get('cleanupErrors') else 1


if __name__ == '__main__':
    raise SystemExit(main())
