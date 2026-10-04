import base64
import copy
import importlib.util
import io
import json
import urllib.error
import pathlib
import struct
import tempfile
import subprocess
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('relay_qualifier', pathlib.Path(__file__).with_name('qualify-relay.py'))
qualifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualifier)


class Relay:
    def __init__(self):
        self.calls = []
        self.node = {'device_id': 'owned', 'device_name': 'animatic-node-qualification-owned',
            'agent_id': 'agent-owned', 'status': 'online', 'current_job_id': None,
            'capacity': {'lease_protocol': True}, 'runtime': {'installed_models': [qualifier.MODEL]},
            'capabilities': {'hosting': {'kind': 'runpod'}}, 'policy': {'revoked': False}}
        self.constraints = ['required_device_id']
        self.jobs = {}
        self.wrong_owner = False
        self.ambiguous_submit = False
        self.late_result = False
        self.cancel_reads = 0

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path == '/status':
            return {'placement_constraints': self.constraints,
                    'agents': [] if self.node['policy']['revoked'] else [copy.deepcopy(self.node)]}
        if path == '/fleet':
            return {'nodes': [copy.deepcopy(self.node)]}
        if path == '/generate':
            job_id = 'job-' + str(len(self.jobs) + 1)
            self.jobs[job_id] = {'job_id': job_id, 'user_id': 'other' if self.wrong_owner else 'owner',
                'required_device_id': body['required_device_id'], 'agent_id': 'agent-owned',
                'status': 'complete' if len(self.jobs) == 0 else 'generating', 'result': None}
            if self.ambiguous_submit:
                raise TimeoutError('No response after server accepted work')
            if self.jobs[job_id]['status'] == 'complete':
                # Header-only fixture; the qualifier explicitly does not claim full decoding.
                png = b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 512, 512) + b'\0' * 9
                self.jobs[job_id]['result'] = {'image_data': base64.b64encode(png).decode()}
            return {'job_id': job_id, 'agent_id': 'agent-owned'}
        if path.startswith('/job/'):
            job_id = path.split('/')[2]
            if path.endswith('/image'):
                return {'deleted': True}
            if method == 'DELETE':
                self.jobs[job_id]['status'] = 'cancelled'
                self.jobs[job_id]['result'] = None
            job = copy.deepcopy(self.jobs[job_id])
            if method == 'GET' and job['status'] == 'cancelled':
                self.cancel_reads += 1
                if self.late_result and self.cancel_reads >= 2:
                    job['result'] = {'image_data': 'late-output'}
            return job
        if path == '/fleet/nodes/owned' and method == 'PATCH':
            self.node['policy'].update(body)
            return copy.deepcopy(self.node)
        raise AssertionError('Unexpected request: ' + path)


class RelayQualificationTests(unittest.TestCase):
    def exercise(self, relay, revoke=False):
        receipt = {'nonce': 'test-nonce'}
        with tempfile.TemporaryDirectory() as directory:
            qualifier.run(relay, 'owned', 'animatic-node-qualification-owned', 'owner',
                pathlib.Path(directory), receipt, lambda: None, sleep=lambda _: None, polls=2, revoke=revoke,
                decode=lambda _: None)
        return receipt

    def test_exact_node_artifact_cancellation_and_scoped_revocation(self):
        relay = Relay()
        receipt = self.exercise(relay, revoke=True)
        self.assertEqual(receipt['status'], 'passed')
        self.assertTrue(receipt['artifactDelivered'])
        self.assertTrue(receipt['cancelledWithoutLateResult'])
        self.assertTrue(receipt['fleetNodeRevokedAndDisconnected'])
        self.assertFalse(receipt['cleanupErrors'])
        self.assertEqual(sum(path == '/generate' for _, path, _ in relay.calls), 2)

    def test_access_refresh_after_model_install_and_during_cleanup(self):
        relay = Relay()
        relay.node['runtime']['installed_models'] = []
        current = ['initial-access']
        provider_calls = []
        class Opener:
            def open(self, request, timeout):
                if request.get_header('Authorization') != 'Bearer ' + current[0]:
                    raise urllib.error.HTTPError(request.full_url, 401, 'expired', {}, None)
                method = request.get_method()
                path = request.full_url.removeprefix('https://relay.mere.run/api')
                body = json.loads(request.data) if request.data else None
                if path == '/fleet/model-plans':
                    value = {'plan_id': 'install'}
                elif path.endswith('/apply'):
                    current[0] = 'refreshed-after-install'
                    value = {}
                elif path == '/fleet/model-plans/install':
                    value = {'state': 'finished'}
                else:
                    value = relay(method, path, body)
                    if path == '/fleet/nodes/owned':
                        current[0] = 'refreshed-for-cleanup'
                return io.BytesIO(json.dumps(value).encode())
        def provider():
            provider_calls.append(current[0])
            return current[0]
        api = qualifier.make_api('initial-access', Opener(), provider)
        receipt = self.exercise(api, revoke=True)
        self.assertEqual(receipt['status'], 'passed')
        self.assertFalse(receipt['cleanupErrors'])
        self.assertIn('refreshed-after-install', provider_calls)
        self.assertIn('refreshed-for-cleanup', provider_calls)
        self.assertEqual(sum(path == '/generate' for _, path, _ in relay.calls), 2)
        self.assertIn(('DELETE', '/job/job-1/image', None), relay.calls)
        self.assertIn(('DELETE', '/job/job-2/image', None), relay.calls)

    def test_provider_rejects_wrong_owner_node_refresh_identity_and_expired_access(self):
        def runner_for(claims):
            token = 'fixture.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.signature'
            return lambda *_, **__: SimpleNamespace(stdout=json.dumps({'access_token': token}).encode())
        valid = {'sub': 'owner', 'client_id': 'animatic-cli', 'exp': 2000}
        self.assertTrue(qualifier.provider_access_token(['/absolute/provider'], 'owner', runner_for(valid), now=lambda: 1000))
        for changes in [{'sub': 'other'}, {'client_id': 'mererun-node'}, {'exp': 1059}]:
            with self.assertRaisesRegex(qualifier.QualificationError, 'failed validation'):
                qualifier.provider_access_token(['/absolute/provider'], 'owner', runner_for({**valid, **changes}), now=lambda: 1000)
        def failed(*_, **__):
            raise subprocess.CalledProcessError(1, ['/provider'], output=b'private provider output', stderr=b'private provider error')
        with self.assertRaises(qualifier.QualificationError) as error:
            qualifier.provider_access_token(['/provider'], 'owner', failed)
        self.assertNotIn('private provider', str(error.exception))

    def test_token_provider_is_direct_argv_not_a_shell_command(self):
        self.assertEqual(qualifier.parse_token_provider('["/usr/bin/node", "provider.mjs"]'), ['/usr/bin/node', 'provider.mjs'])
        for value in ['"node provider.mjs"', '["node", "provider.mjs"]', '[]', '[42]']:
            with self.assertRaises(qualifier.QualificationError):
                qualifier.parse_token_provider(value)

    def test_auth_failure_does_not_replay_mutation(self):
        calls = []
        class Opener:
            def open(self, request, timeout):
                calls.append(request.get_method())
                raise urllib.error.HTTPError(request.full_url, 401, 'expired', {}, None)
        api = qualifier.make_api('old', Opener(), lambda: 'fresh')
        with self.assertRaises(urllib.error.HTTPError) as error:
            api('POST', '/generate', {})
        error.exception.close()
        self.assertEqual(calls, ['POST'])

    def test_old_relay_cannot_silently_fall_back(self):
        relay = Relay()
        relay.constraints = []
        with self.assertRaisesRegex(qualifier.QualificationError, 'enforced device'):
            self.exercise(relay)
        self.assertTrue(all(method == 'GET' for method, _, _ in relay.calls))

    def test_existing_unrelated_node_cannot_be_qualified_or_revoked(self):
        relay = Relay()
        relay.node['device_name'] = 'Personal workstation'
        with self.assertRaisesRegex(qualifier.QualificationError, 'owned qualification'):
            self.exercise(relay, revoke=True)
        self.assertTrue(all(method == 'GET' for method, _, _ in relay.calls))

    def test_wrong_owner_result_is_rejected_and_known_job_cleaned_up(self):
        relay = Relay()
        relay.wrong_owner = True
        with self.assertRaisesRegex(qualifier.QualificationError, 'ownership'):
            self.exercise(relay)
        self.assertIn(('DELETE', '/job/job-1/image', None), relay.calls)
        self.assertEqual(len(relay.jobs), 1)

    def test_ambiguous_post_is_not_replayed(self):
        relay = Relay()
        relay.ambiguous_submit = True
        with self.assertRaises(TimeoutError):
            self.exercise(relay)
        self.assertEqual(sum(path == '/generate' for _, path, _ in relay.calls), 1)
        self.assertFalse(relay.node['policy']['revoked'])

    def test_late_output_after_cancel_is_a_failed_qualification(self):
        relay = Relay()
        relay.late_result = True
        with self.assertRaisesRegex(qualifier.QualificationError, 'Late result'):
            self.exercise(relay)

    def test_redirect_never_receives_account_bearer(self):
        with self.assertRaises(qualifier.QualificationError):
            qualifier.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example')

    def test_refresh_revocation_requires_rejected_refresh_not_just_200(self):
        calls = []
        def post(path, body):
            calls.append((path, body))
            return (200, {}) if path == '/oauth/revoke' else (400, {'error': 'invalid_grant'})
        qualifier.revoke_dedicated_refresh(post, 'odrt_dedicated-fixture')
        self.assertEqual([path for path, _ in calls], ['/oauth/revoke', '/oauth/token'])
        self.assertTrue(all(body['client_id'] == 'mererun-node' for _, body in calls))
        with self.assertRaisesRegex(qualifier.QualificationError, 'did not produce'):
            qualifier.revoke_dedicated_refresh(lambda *_: (200, {}), 'odrt_dedicated-fixture')


if __name__ == '__main__':
    unittest.main()
