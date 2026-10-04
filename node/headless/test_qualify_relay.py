import base64
import copy
import importlib.util
import pathlib
import struct
import tempfile
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
